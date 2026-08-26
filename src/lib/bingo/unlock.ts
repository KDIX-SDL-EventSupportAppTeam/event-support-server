import { randomUUID } from 'node:crypto'
import type { AppConfig } from '../../config.js'
import type { DbClient } from '../../db/client.js'
import { assignOuterCellsForPairs, countGlobalCheckins, type PairAssignmentContext } from './assignOuterCells.js'
import { computeNewlyCompletedPairs, pairDefinitionByKey, type PairDefinition } from './unlockPairs.js'

/** 1ペアぶんの解放結果。フロントは解放演出の再生済みフラグを pair_key 単位で管理する。 */
export type UnlockedPair = {
  pair_key: string
  released_positions: number[]
}

export type UnlockResult = {
  unlockedPositions: number[]
  unlockEventIds: string[]
  /**
   * 成立したペアごとの解放内訳。unlockedPositions は全ペア分が平坦に混ざるため、
   * ペア単位の復元には使えない（正本はサーバー側。フロントで対応表を複製しない）。
   */
  unlockedPairs: UnlockedPair[]
}

/**
 * 解放処理（本機能の中核）。docs/specs/bingo-dynamic-unlock/03-card-lifecycle/unlock.md
 *
 * トリガー: 中央マスが新たに達成された瞬間。チェックイン処理の同一リクエスト内で同期的に実行する。
 * 外周マスの達成では呼ばないこと（unlock-pairs.md）。
 *
 * 冪等性: 新規ペアごとに card_unlock_events へ SELECT→INSERT する。INSERT できたリクエストだけが
 * そのペアの推薦・割当を行う（D-15。SELECT ... FOR UPDATE は使えない）。
 */
export async function processCenterAchievement(
  db: DbClient,
  config: AppConfig,
  eventId: string,
  userId: string,
  cardId: string,
): Promise<UnlockResult> {
  const achievedCenter = await getAchievedCenterPositions(db, cardId)
  const alreadyUnlockedKeys = await getUnlockedPairKeys(db, cardId)

  const newPairs = computeNewlyCompletedPairs(achievedCenter, alreadyUnlockedKeys)
  if (!newPairs.length) return { unlockedPositions: [], unlockEventIds: [], unlockedPairs: [] }

  const globalCheckinCount = await countGlobalCheckins(db, eventId)

  // 手順2: ペアごとに解放の権利を取る（冪等性の要）
  const wonPairs: { pair: PairDefinition; unlockEventId: string }[] = []
  for (const pair of newPairs) {
    const unlockEventId = await tryClaimPair(db, cardId, pair, globalCheckinCount)
    if (unlockEventId) wonPairs.push({ pair, unlockEventId })
  }
  if (!wonPairs.length) return { unlockedPositions: [], unlockEventIds: [], unlockedPairs: [] }

  const cellsByPosition = await getOuterCellsByPosition(db, cardId)

  const pairContexts: PairAssignmentContext[] = wonPairs.map(({ pair, unlockEventId }) => ({
    unlockEventId,
    pairKey: pair.pairKey,
    targets: pair.releasedPositions
      .map((pos) => {
        const cellId = cellsByPosition.get(pos)
        return cellId ? { cellId, position: pos } : null
      })
      .filter((t): t is { cellId: string; position: number } => t !== null),
  }))

  const { releasedPositions } = await assignOuterCellsForPairs(db, config, eventId, userId, cardId, pairContexts, {
    globalCheckinCount, // C-1: 同一リクエスト内で数え直さない
  })

  const releasedSet = new Set(releasedPositions)
  return {
    unlockedPositions: releasedPositions,
    unlockEventIds: wonPairs.map((w) => w.unlockEventId),
    unlockedPairs: pairContexts.map((ctx) => ({
      pair_key: ctx.pairKey,
      released_positions: ctx.targets.map((t) => t.position).filter((p) => releasedSet.has(p)),
    })),
  }
}

async function getAchievedCenterPositions(db: DbClient, cardId: string): Promise<Set<number>> {
  const [rows] = await db.query(
    `SELECT position FROM bingo_cells WHERE card_id = ? AND zone = 'CENTER' AND is_achieved = 1`,
    [cardId],
  )
  return new Set((rows as { position: number }[]).map((r) => r.position))
}

async function getUnlockedPairKeys(db: DbClient, cardId: string): Promise<Set<string>> {
  const [rows] = await db.query(
    `SELECT pair_key FROM card_unlock_events WHERE card_id = ? AND pair_key <> 'PRESURVEY'`,
    [cardId],
  )
  return new Set((rows as { pair_key: string }[]).map((r) => r.pair_key))
}

async function getOuterCellsByPosition(db: DbClient, cardId: string): Promise<Map<number, string>> {
  const [rows] = await db.query(`SELECT id, position FROM bingo_cells WHERE card_id = ? AND zone = 'OUTER'`, [
    cardId,
  ])
  return new Map((rows as { id: string; position: number }[]).map((r) => [r.position, r.id]))
}

/**
 * 1ペアぶんの card_unlock_events を排他的に確保する。
 * INSERT 前に SELECT で存在確認する（プロキシは重複キーを 500 に潰すため。ADR 0001）。
 * 既に行があれば他リクエストが処理済みなので null を返す。
 *
 * phase/decision_table_size はこの時点では未確定のため暫定値で INSERT し、
 * assignOuterCellsForPairs 完了後に確定値へ UPDATE する。
 */
async function tryClaimPair(
  db: DbClient,
  cardId: string,
  pair: PairDefinition,
  globalCheckinCount: number,
): Promise<string | null> {
  const [existingRows] = await db.query(
    `SELECT id FROM card_unlock_events WHERE card_id = ? AND pair_key = ? LIMIT 1`,
    [cardId, pair.pairKey],
  )
  if ((existingRows as { id: string }[])[0]) return null

  const id = randomUUID()
  try {
    await db.execute(
      `INSERT INTO card_unlock_events
         (id, card_id, pair_key, line_index, released_positions, phase, strategy, decision_table_size, global_checkin_count)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        id,
        cardId,
        pair.pairKey,
        pair.lineIndex,
        pair.releasedPositions.join(','),
        'COVERAGE',
        'PENDING',
        null,
        globalCheckinCount,
      ],
    )
    return id
  } catch (e: unknown) {
    const err = e as { code?: string }
    if (err.code === 'ER_DUP_ENTRY') return null // 他リクエストが先に確保した
    throw e
  }
}

/**
 * 自己修復（E9 / fallback.md）。
 * card_unlock_events は存在するのに、その released_positions のマスが is_revealed=0 のままの
 * カードを検知したら、その場でフォールバック割当込みの assignOuterCellsForPairs を実行して直す。
 * カード取得 API から呼ばれる。3回ぶんの解放イベントすべてを独立して点検する。
 */
export async function healUnlockedCardIfNeeded(
  db: DbClient,
  config: AppConfig,
  eventId: string,
  userId: string,
  cardId: string,
): Promise<void> {
  // C-6: 修復不要（＝ほぼ全ての呼び出し）を1クエリで安く判定する。
  // 「解放イベントの released_positions に含まれる外周マスが is_revealed=0 で残っている」
  // イベントだけを直接引く。該当が無ければここで終わり（従来は毎回3クエリ走っていた）。
  const [eventRows] = await db.query(
    `SELECT cue.id, cue.pair_key, cue.released_positions
       FROM card_unlock_events cue
      WHERE cue.card_id = ? AND cue.pair_key <> 'PRESURVEY'
        AND EXISTS (
          SELECT 1 FROM bingo_cells bc
           WHERE bc.card_id = cue.card_id AND bc.zone = 'OUTER' AND bc.is_revealed = 0
             AND FIND_IN_SET(bc.position, cue.released_positions)
        )`,
    [cardId],
  )
  const events = eventRows as { id: string; pair_key: string; released_positions: string }[]
  if (!events.length) return

  // ここから先は実際に壊れているカードだけが通る。外周マスの id/position/is_revealed を1クエリで取る。
  const [cellRows] = await db.query(
    `SELECT id, position, is_revealed FROM bingo_cells WHERE card_id = ? AND zone = 'OUTER'`,
    [cardId],
  )
  const outerCells = cellRows as { id: string; position: number; is_revealed: number }[]
  const cellsByPosition = new Map(outerCells.map((c) => [c.position, c.id]))
  const revealedPositions = new Set(outerCells.filter((c) => Number(c.is_revealed) === 1).map((c) => c.position))

  const needsHeal: PairAssignmentContext[] = []
  for (const ev of events) {
    const positions = ev.released_positions
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n))

    const def = pairDefinitionByKey(ev.pair_key)
    const targets = (def ? def.releasedPositions : positions)
      .map((pos) => {
        const cellId = cellsByPosition.get(pos)
        return cellId && !revealedPositions.has(pos) ? { cellId, position: pos } : null
      })
      .filter((t): t is { cellId: string; position: number } => t !== null)
    if (targets.length) needsHeal.push({ unlockEventId: ev.id, pairKey: ev.pair_key, targets })
  }

  if (needsHeal.length) {
    await assignOuterCellsForPairs(db, config, eventId, userId, cardId, needsHeal, { isSelfHeal: true })
  }
}
