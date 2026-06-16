import type { DbClient } from '../../db/client.js'
import {
  SAMPLE_EMAIL_DOMAIN,
  SAMPLE_PREFIX,
  ensureBoothCategoriesTable,
} from './constants.js'

export type SampleClearResult = {
  deleted: {
    users: number
    booths: number
    categories: number
    survey_questions: number
  }
}

async function sampleUserIds(db: DbClient, eventId: string): Promise<string[]> {
  const [rows] = await db.query(
    `SELECT id FROM users WHERE event_id = ? AND email LIKE ?`,
    [eventId, `%@${SAMPLE_EMAIL_DOMAIN}`],
  )
  return (rows as { id: string }[]).map((r) => r.id)
}

async function sampleBoothIds(db: DbClient, eventId: string): Promise<string[]> {
  const [rows] = await db.query(
    `SELECT id FROM booths WHERE event_id = ? AND name LIKE ?`,
    [eventId, `${SAMPLE_PREFIX}%`],
  )
  return (rows as { id: string }[]).map((r) => r.id)
}

async function sampleCategoryIds(db: DbClient, eventId: string): Promise<string[]> {
  const [rows] = await db.query(
    `SELECT id FROM categories WHERE event_id = ? AND name LIKE ?`,
    [eventId, `${SAMPLE_PREFIX}%`],
  )
  return (rows as { id: string }[]).map((r) => r.id)
}

export async function clearSampleData(db: DbClient, eventId: string): Promise<SampleClearResult> {
  await ensureBoothCategoriesTable(db)

  const userIds = await sampleUserIds(db, eventId)
  const boothIds = await sampleBoothIds(db, eventId)
  const categoryIds = await sampleCategoryIds(db, eventId)

  if (!userIds.length && !boothIds.length && !categoryIds.length) {
    return { deleted: { users: 0, booths: 0, categories: 0, survey_questions: 0 } }
  }

  if (userIds.length) {
    const placeholders = userIds.map(() => '?').join(',')
    await db.execute(`DELETE FROM recommendations WHERE event_id = ? AND user_id IN (${placeholders})`, [
      eventId,
      ...userIds,
    ])
    await db.execute(
      `DELETE FROM user_survey_answers WHERE event_id = ? AND user_id IN (${placeholders})`,
      [eventId, ...userIds],
    )
    await db.execute(`DELETE FROM booth_ratings WHERE event_id = ? AND user_id IN (${placeholders})`, [
      eventId,
      ...userIds,
    ])
    await db.execute(`DELETE FROM check_ins WHERE event_id = ? AND user_id IN (${placeholders})`, [
      eventId,
      ...userIds,
    ])
  }

  if (boothIds.length) {
    const placeholders = boothIds.map(() => '?').join(',')
    await db.execute(`DELETE FROM booth_ratings WHERE event_id = ? AND booth_id IN (${placeholders})`, [
      eventId,
      ...boothIds,
    ])
    await db.execute(`DELETE FROM check_ins WHERE event_id = ? AND booth_id IN (${placeholders})`, [
      eventId,
      ...boothIds,
    ])
    await db.execute(`DELETE FROM booth_tags WHERE booth_id IN (${placeholders})`, boothIds)
    await db.execute(`DELETE FROM booth_categories WHERE booth_id IN (${placeholders})`, boothIds)
  }

  if (categoryIds.length) {
    const placeholders = categoryIds.map(() => '?').join(',')
    await db.execute(`DELETE FROM booth_categories WHERE category_id IN (${placeholders})`, categoryIds)
  }

  let deletedUsers = 0
  if (userIds.length) {
    const placeholders = userIds.map(() => '?').join(',')
    const [res] = await db.execute(
      `DELETE FROM users WHERE event_id = ? AND id IN (${placeholders})`,
      [eventId, ...userIds],
    )
    deletedUsers = (res as { affectedRows?: number }).affectedRows ?? 0
  }

  let deletedBooths = 0
  if (boothIds.length) {
    const placeholders = boothIds.map(() => '?').join(',')
    const [res] = await db.execute(
      `DELETE FROM booths WHERE event_id = ? AND id IN (${placeholders})`,
      [eventId, ...boothIds],
    )
    deletedBooths = (res as { affectedRows?: number }).affectedRows ?? 0
  }

  const [sqRes] = await db.execute(
    `DELETE FROM survey_questions WHERE event_id = ? AND question_text LIKE ?`,
    [eventId, `${SAMPLE_PREFIX}%`],
  )
  const deletedQuestions = (sqRes as { affectedRows?: number }).affectedRows ?? 0

  let deletedCategories = 0
  if (categoryIds.length) {
    const placeholders = categoryIds.map(() => '?').join(',')
    const [res] = await db.execute(
      `DELETE FROM categories WHERE event_id = ? AND id IN (${placeholders})`,
      [eventId, ...categoryIds],
    )
    deletedCategories = (res as { affectedRows?: number }).affectedRows ?? 0
  }

  return {
    deleted: {
      users: deletedUsers,
      booths: deletedBooths,
      categories: deletedCategories,
      survey_questions: deletedQuestions,
    },
  }
}
