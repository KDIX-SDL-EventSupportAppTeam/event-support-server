/**
 * アワード投票の開閉設定（issue #124）。
 *
 * `award_settings` はイベント単位。行が無いイベントは既定 `is_open = false` として扱う
 * （`fetchGachaSettings` と同じく、行が無くてもコード側の既定値で動かす）。
 */
import type { DbClient } from '../../db/client.js'

export const DEFAULT_AWARD_SETTINGS = { isOpen: false }

export async function fetchAwardSettings(
  db: DbClient,
  eventId: string,
): Promise<{ isOpen: boolean }> {
  const [rows] = await db.query(
    'SELECT is_open FROM award_settings WHERE event_id = ? LIMIT 1',
    [eventId],
  )
  const row = (rows as { is_open: number | null }[])[0]
  if (!row || row.is_open === null || row.is_open === undefined) {
    return { ...DEFAULT_AWARD_SETTINGS }
  }
  return { isOpen: Boolean(Number(row.is_open)) }
}
