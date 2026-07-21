import type { DbClient } from '../../db/client.js'
import { hasBoothCategoriesTable } from '../sample-data/constants.js'

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

async function boothIdsForEvent(db: DbClient, eventId: string): Promise<string[]> {
  const [rows] = await db.query('SELECT id FROM booths WHERE event_id = ?', [eventId])
  return (rows as { id: string }[]).map((r) => r.id)
}

async function deleteByBoothIds(
  db: DbClient,
  table: 'booth_tags' | 'booth_categories',
  boothIds: string[],
): Promise<number> {
  if (!boothIds.length) return 0
  const placeholders = boothIds.map(() => '?').join(',')
  const [res] = await db.execute(
    `DELETE FROM ${table} WHERE booth_id IN (${placeholders})`,
    boothIds,
  )
  return affectedRows(res)
}

async function assertEventExists(db: DbClient, eventId: string): Promise<void> {
  const [rows] = await db.query('SELECT id FROM events WHERE id = ? LIMIT 1', [eventId])
  if (!(rows as { id: string }[])[0]) {
    throw new Error(`イベントが見つかりません: ${eventId}`)
  }
}

/** イベント配下の全データを削除する（events 行・運営/出展者アカウント・organizer・audit_logs は残す。organizer 専用ルートから呼ばれる） */
export async function clearAllEventData(db: DbClient, eventId: string): Promise<EventDataClearResult> {
  await assertEventExists(db, eventId)
  const hasBoothCategories = await hasBoothCategoriesTable(db)
  const boothIds = await boothIdsForEvent(db, eventId)

  const [recRes] = await db.execute('DELETE FROM recommendations WHERE event_id = ?', [eventId])
  const [usaRes] = await db.execute('DELETE FROM user_survey_answers WHERE event_id = ?', [eventId])
  const [brRes] = await db.execute('DELETE FROM booth_ratings WHERE event_id = ?', [eventId])
  const [ciRes] = await db.execute('DELETE FROM check_ins WHERE event_id = ?', [eventId])

  const deletedTags = await deleteByBoothIds(db, 'booth_tags', boothIds)
  const deletedBoothCategories = hasBoothCategories
    ? await deleteByBoothIds(db, 'booth_categories', boothIds)
    : 0

  const [boothRes] = await db.execute('DELETE FROM booths WHERE event_id = ?', [eventId])
  const [userRes] = await db.execute(
    `DELETE FROM users WHERE event_id = ? AND role IN ('participant', 'exhibitor')`,
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
      booth_tags: deletedTags,
      booth_categories: deletedBoothCategories,
      booths: affectedRows(boothRes),
      participants: affectedRows(userRes),
      survey_questions: affectedRows(sqRes),
      categories: affectedRows(catRes),
    },
  }
}
