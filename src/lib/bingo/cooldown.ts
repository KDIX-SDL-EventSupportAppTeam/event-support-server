import type { DbClient } from '../../db/client.js'

/**
 * クールタイム判定。docs/.sdd/03-card-lifecycle/cooldown.md
 * `CHECKIN_COOLDOWN_SEC = 0`（既定）のときは判定自体をスキップする（DB 問い合わせもしない）。
 * 判定にはサーバーの現在時刻との差を使う（クライアント由来の checked_in_at は使わない）。
 */
export async function checkCooldown(
  db: DbClient,
  cooldownSec: number,
  userId: string,
  eventId: string,
): Promise<{ blocked: boolean; remainingSec: number }> {
  if (cooldownSec <= 0) {
    return { blocked: false, remainingSec: 0 }
  }

  const [rows] = await db.query(
    `SELECT checked_in_at FROM check_ins
     WHERE user_id = ? AND event_id = ?
     ORDER BY checked_in_at DESC LIMIT 1`,
    [userId, eventId],
  )
  const row = (rows as { checked_in_at: string }[])[0]
  if (!row) {
    return { blocked: false, remainingSec: 0 }
  }

  const lastMs = new Date(`${String(row.checked_in_at).replace(' ', 'T')}Z`).getTime()
  if (Number.isNaN(lastMs)) {
    return { blocked: false, remainingSec: 0 }
  }

  const elapsedSec = (Date.now() - lastMs) / 1000
  const remaining = cooldownSec - elapsedSec
  if (remaining <= 0) {
    return { blocked: false, remainingSec: 0 }
  }
  return { blocked: true, remainingSec: Math.ceil(remaining) }
}
