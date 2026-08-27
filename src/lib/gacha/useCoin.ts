/**
 * コイン消費の排他制御。**本仕様で最も壊れやすい箇所。**
 *
 * 本番 DB は 1リクエスト = 1SQL で、トランザクションも行ロックも無く、
 * さらにプロキシが `ER_DUP_ENTRY` を 500 に潰す（ADR 0001）。
 * このため例外コードで分岐せず、「INSERT ... SELECT ... HAVING」の affectedRows と、
 * 例外時の idempotency_key での SELECT だけで多重消費を殺す。
 *
 * 仕様: docs/specs/gacha-and-award/03-coin-lifecycle/spending.md
 */
import { randomUUID } from 'node:crypto'
import type { DbClient } from '../../db/client.js'
import { mysqlUtcToIso } from '../datetime.js'

/** 所持枚数 0（HAVING 不成立）。ルートは 409 NO_COINS_AVAILABLE に変換する。 */
export class NoCoinsAvailableError extends Error {
  constructor() {
    super('NO_COINS_AVAILABLE')
    this.name = 'NoCoinsAvailableError'
  }
}

export interface UseCoinInput {
  eventId: string
  userId: string
  /** クライアント生成の冪等キー（G-5）。再送でも同じ値。 */
  idempotencyKey: string
  /**
   * 手順2: 現在のビンゴから earned を算出する。
   * 手順4の再試行時にもう一度呼ばれる（ライン数は単調非減少なので過剰消費にはならない）。
   */
  computeEarned: () => Promise<number>
}

export interface UseCoinResult {
  coinIndex: number
  /** ISO 8601（'...Z'）。 */
  usedAt: string
  /** 手順4の衝突で1回だけ再試行したか。 */
  retried: boolean
}

interface InsertHeader {
  affectedRows: number
}
interface UseRow {
  coin_index: number
  used_at: string
}

type AttemptOutcome =
  | { kind: 'success'; coinIndex: number; usedAt: string }
  | { kind: 'no_coins' }
  | { kind: 'conflict' }

/** 既存行（冪等キーの勝者側）を引く。 */
async function findByIdempotencyKey(
  db: DbClient,
  input: UseCoinInput,
): Promise<{ coinIndex: number; usedAt: string } | null> {
  const [rows] = await db.query(
    `SELECT coin_index, used_at
       FROM gacha_coin_uses
      WHERE event_id = ? AND user_id = ? AND idempotency_key = ?
      LIMIT 1`,
    [input.eventId, input.userId, input.idempotencyKey],
  )
  const row = (rows as UseRow[])[0]
  if (!row) return null
  return { coinIndex: Number(row.coin_index), usedAt: mysqlUtcToIso(row.used_at) }
}

/** 手順2〜4 の1回分。 */
async function attempt(db: DbClient, input: UseCoinInput): Promise<AttemptOutcome> {
  const earned = await input.computeEarned()
  const id = randomUUID()

  try {
    // 手順3: 残高超過を SQL 自身に判定させる単一 INSERT
    const [header] = await db.execute(
      `INSERT INTO gacha_coin_uses (id, event_id, user_id, coin_index, idempotency_key)
       SELECT ?, ?, ?, COUNT(*), ?
         FROM gacha_coin_uses
        WHERE event_id = ? AND user_id = ?
       HAVING COUNT(*) < ?`,
      [id, input.eventId, input.userId, input.idempotencyKey, input.eventId, input.userId, earned],
    )
    const affected = (header as InsertHeader).affectedRows ?? 0

    if (affected === 1) {
      const [rows] = await db.query(
        `SELECT coin_index, used_at FROM gacha_coin_uses WHERE id = ? LIMIT 1`,
        [id],
      )
      const row = (rows as UseRow[])[0]
      // 直後に消えることは無い（追記のみ）。取れなければ想定外なので通常フローで失敗させる。
      return {
        kind: 'success',
        coinIndex: Number(row.coin_index),
        usedAt: mysqlUtcToIso(row.used_at),
      }
    }

    // affectedRows = 0 → HAVING 不成立 = 残高ゼロ
    return { kind: 'no_coins' }
  } catch {
    // 手順4: 例外時（プロキシ経由では 500）。握りつぶさず必ず idempotency_key で判定する。
    const existing = await findByIdempotencyKey(db, input)
    if (existing) {
      // 再送・並行の勝者側の行。その操作は成立している。
      return { kind: 'success', ...existing }
    }
    // 行が無い → uk_gacha_coin の衝突（同時実行の敗者）
    return { kind: 'conflict' }
  }
}

/**
 * コインを1枚消費する。
 * - 成功: `UseCoinResult` を返す（同一冪等キーの再送・並行でも同じ行を返す）
 * - 残高ゼロ: `NoCoinsAvailableError` を投げる
 * - 衝突が再試行後も解消しない: 例外を投げる（ルートは 500）
 */
export async function useCoin(db: DbClient, input: UseCoinInput): Promise<UseCoinResult> {
  const first = await attempt(db, input)
  if (first.kind === 'success') {
    return { coinIndex: first.coinIndex, usedAt: first.usedAt, retried: false }
  }
  if (first.kind === 'no_coins') {
    throw new NoCoinsAvailableError()
  }

  // conflict → 手順2から1回だけ再試行
  const second = await attempt(db, input)
  if (second.kind === 'success') {
    return { coinIndex: second.coinIndex, usedAt: second.usedAt, retried: true }
  }
  if (second.kind === 'no_coins') {
    throw new NoCoinsAvailableError()
  }
  throw new Error('gacha useCoin: 再試行後も uk_gacha_coin の衝突が解消しませんでした')
}
