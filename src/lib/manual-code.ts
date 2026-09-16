import { randomInt } from 'node:crypto'
import type { DbClient } from '../db/client.js'

/**
 * 手動チェックインコード（6桁数字）の生成。
 *
 * issue #121 の決定:
 * - 形式は `^[0-9]{6}$`。英字は使わない（当日の入力負荷を下げる）
 * - 暗号論的乱数（`node:crypto` の `randomInt`）で生成する。`Math.random()` は使わない
 * - 連番にしない（隣を推測させない）
 * - 同一イベント内で重複したら引き直す（`UNIQUE (event_id, manual_code)` を握りつぶさない）
 * - 生成した値そのものはログに出さない
 *
 * 参加者に配ってはいけない秘密のコードなので、ここで作った値を
 * console / audit_logs の本文へ出さないこと。
 */

/** 6桁ゼロ埋めの数字コードを1つ返す（暗号論的乱数）。 */
export function generateManualCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** 6桁数字コードとして妥当か。 */
export function isValidManualCode(value: string): boolean {
  return /^[0-9]{6}$/.test(value)
}

const MAX_ATTEMPTS = 8

/**
 * 同一イベント内で衝突しない 6桁数字コードを採番する。
 *
 * さくらプロキシは重複キーエラーを 500 に潰すため、INSERT 前に SELECT で
 * 空きを確認する（AGENTS.md 原則2）。数回引き直しても空かなければ例外を投げる。
 */
export async function generateUniqueManualCode(
  db: DbClient,
  eventId: string,
): Promise<string> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const code = generateManualCode()
    const [rows] = await db.query(
      'SELECT 1 AS x FROM booths WHERE event_id = ? AND manual_code = ? LIMIT 1',
      [eventId, code],
    )
    if (!(rows as unknown[])[0]) return code
  }
  throw new Error(
    `手動コードの採番に${MAX_ATTEMPTS}回失敗しました（event_id=${eventId}）`,
  )
}
