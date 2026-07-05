import type { DbClient } from '../db/client.js'

/**
 * オーガナイザーが当該イベントを所有しているかを判定する。
 *
 * `organizer_id` が NULL の（手動 SQL で作成された）イベントは
 * どのオーガナイザーからも false になる。これは仕様（.sdd 01-api.md 1.1 参照）。
 */
export async function assertEventOwnedByOrganizer(
  db: DbClient,
  eventId: string,
  organizerId: string,
): Promise<boolean> {
  const [rows] = await db.query(
    'SELECT id FROM events WHERE id = ? AND organizer_id = ? LIMIT 1',
    [eventId, organizerId],
  )
  return Boolean((rows as { id: string }[])[0])
}
