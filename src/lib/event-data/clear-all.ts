import type { DbClient } from '../../db/client.js'
import { ensureBoothCategoriesTable } from '../sample-data/constants.js'

export type EventDataClearResult = {
  deleted: {
    recommendations: number
    survey_answers: number
    ratings: number
    checkins: number
    booth_tags: number
    booth_categories: number
    booths: number
    participants: number
    survey_questions: number
    categories: number
  }
}

function affectedRows(result: unknown): number {
  return (result as { affectedRows?: number }).affectedRows ?? 0
}

async function assertEventExists(db: DbClient, eventId: string): Promise<void> {
  const [rows] = await db.query('SELECT id FROM events WHERE id = ? LIMIT 1', [eventId])
  if (!(rows as { id: string }[])[0]) {
    throw new Error(`イベントが見つかりません: ${eventId}`)
  }
}

/** イベント配下の全データを削除する（events 行と admin ユーザーは残す） */
export async function clearAllEventData(db: DbClient, eventId: string): Promise<EventDataClearResult> {
  await ensureBoothCategoriesTable(db)
  await assertEventExists(db, eventId)

  const [recRes] = await db.execute('DELETE FROM recommendations WHERE event_id = ?', [eventId])
  const [usaRes] = await db.execute('DELETE FROM user_survey_answers WHERE event_id = ?', [eventId])
  const [brRes] = await db.execute('DELETE FROM booth_ratings WHERE event_id = ?', [eventId])
  const [ciRes] = await db.execute('DELETE FROM check_ins WHERE event_id = ?', [eventId])

  const [btRes] = await db.execute(
    `DELETE bt FROM booth_tags bt
     INNER JOIN booths b ON b.id = bt.booth_id
     WHERE b.event_id = ?`,
    [eventId],
  )

  const [bcRes] = await db.execute(
    `DELETE bc FROM booth_categories bc
     INNER JOIN booths b ON b.id = bc.booth_id
     WHERE b.event_id = ?`,
    [eventId],
  )

  const [boothRes] = await db.execute('DELETE FROM booths WHERE event_id = ?', [eventId])
  const [userRes] = await db.execute(
    `DELETE FROM users WHERE event_id = ? AND role = 'participant'`,
    [eventId],
  )
  const [sqRes] = await db.execute('DELETE FROM survey_questions WHERE event_id = ?', [eventId])
  const [catRes] = await db.execute('DELETE FROM categories WHERE event_id = ?', [eventId])

  return {
    deleted: {
      recommendations: affectedRows(recRes),
      survey_answers: affectedRows(usaRes),
      ratings: affectedRows(brRes),
      checkins: affectedRows(ciRes),
      booth_tags: affectedRows(btRes),
      booth_categories: affectedRows(bcRes),
      booths: affectedRows(boothRes),
      participants: affectedRows(userRes),
      survey_questions: affectedRows(sqRes),
      categories: affectedRows(catRes),
    },
  }
}
