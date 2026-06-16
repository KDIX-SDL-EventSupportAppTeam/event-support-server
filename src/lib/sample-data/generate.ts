import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { DbClient } from '../../db/client.js'
import {
  SAMPLE_DEFAULTS,
  SAMPLE_PREFIX,
  SAMPLE_USER_PASSWORD,
  ensureBoothCategoriesTable,
  sampleBoothName,
  sampleCategoryName,
  sampleManualCode,
  sampleParticipantDisplayName,
  sampleParticipantEmail,
} from './constants.js'
import { clearSampleData } from './clear.js'
import { SampleDataConflictError } from './errors.js'

const AGE_RANGES = ['10代', '20代', '30代', '40代', '50代以上']
const OCCUPATIONS = ['学生', '会社員', '経営者', 'その他']
const INDUSTRIES = ['IT', '製造', '金融', '医療', 'その他']

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function pickMany<T>(arr: T[], count: number): T[] {
  const copy = [...arr]
  const out: T[] = []
  for (let i = 0; i < count && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length)
    out.push(copy.splice(idx, 1)[0])
  }
  return out
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3600 * 1000)
}

export type SampleGenerateResult = {
  categories: number
  booths: number
  participants: number
  checkins: number
  ratings: number
  recommendations: number
  survey_answers: number
  survey_questions: number
}

async function assertEventExists(db: DbClient, eventId: string): Promise<void> {
  const [rows] = await db.query('SELECT id FROM events WHERE id = ? LIMIT 1', [eventId])
  if (!(rows as { id: string }[])[0]) {
    throw new Error(`イベントが見つかりません: ${eventId}`)
  }
}

async function assertNoExistingSample(db: DbClient, eventId: string, force: boolean): Promise<void> {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS c FROM booths WHERE event_id = ? AND name LIKE ?`,
    [eventId, `${SAMPLE_PREFIX}%`],
  )
  const count = Number((rows as { c: number }[])[0]?.c ?? 0)
  if (count > 0 && !force) {
    throw new SampleDataConflictError(
      `${SAMPLE_PREFIX} ブースが既に ${count} 件あります。削除してから再実行するか --force を指定してください。`,
    )
  }
  if (count > 0 && force) {
    await clearSampleData(db, eventId)
  }
}

export async function generateSampleData(
  db: DbClient,
  eventId: string,
  options: { force?: boolean } = {},
): Promise<SampleGenerateResult> {
  await assertEventExists(db, eventId)
  await assertNoExistingSample(db, eventId, options.force ?? false)

  const hasBoothCategories = await ensureBoothCategoriesTable(db)

  const categoryCount = SAMPLE_DEFAULTS.categoryCount
  const boothCount = SAMPLE_DEFAULTS.boothCount
  const participantCount = SAMPLE_DEFAULTS.participantCount

  const categoryIds: string[] = []
  for (let i = 1; i <= categoryCount; i++) {
    const id = randomUUID()
    categoryIds.push(id)
    await db.execute(`INSERT INTO categories (id, event_id, name) VALUES (?,?,?)`, [
      id,
      eventId,
      sampleCategoryName(i),
    ])
  }

  const boothIds: string[] = []
  for (let i = 1; i <= boothCount; i++) {
    const id = randomUUID()
    boothIds.push(id)
    const boothCategories = pickMany(categoryIds, randomInt(2, 4))
    await db.execute(
      `INSERT INTO booths (id, event_id, name, description, category_id, manual_code)
       VALUES (?,?,?,?,?,?)`,
      [
        id,
        eventId,
        sampleBoothName(i),
        `${SAMPLE_PREFIX} デモ用ブースです（分析・チェックイン確認用）`,
        boothCategories[0],
        sampleManualCode(i),
      ],
    )
    for (const catId of boothCategories) {
      if (hasBoothCategories) {
        await db.execute(
          `INSERT INTO booth_categories (booth_id, category_id) VALUES (?,?)`,
          [id, catId],
        )
      }
    }
    await db.execute(`INSERT INTO booth_tags (id, booth_id, tag) VALUES (?,?,?)`, [
      randomUUID(),
      id,
      SAMPLE_PREFIX,
    ])
    await db.execute(`INSERT INTO booth_tags (id, booth_id, tag) VALUES (?,?,?)`, [
      randomUUID(),
      id,
      'デモ',
    ])
  }

  const questionIds: string[] = []
  const surveyQuestions = [
    {
      text: `${SAMPLE_PREFIX} 今日の満足度は？`,
      options: ['とても満足', '満足', '普通', '不満'],
    },
    {
      text: `${SAMPLE_PREFIX} 再参加意向は？`,
      options: ['ぜひ参加したい', '参加したい', 'どちらでもない', '参加しない'],
    },
  ]
  for (const [idx, q] of surveyQuestions.entries()) {
    const qid = randomUUID()
    questionIds.push(qid)
    await db.execute(
      `INSERT INTO survey_questions (id, event_id, question_text, options, display_order, is_required)
       VALUES (?,?,?,?,?,?)`,
      [qid, eventId, q.text, JSON.stringify(q.options), idx + 1, 0],
    )
  }

  const passwordHash = await bcrypt.hash(SAMPLE_USER_PASSWORD, 10)
  const userIds: string[] = []
  for (let i = 1; i <= participantCount; i++) {
    const id = randomUUID()
    userIds.push(id)
    await db.execute(
      `INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)`,
      [
        id,
        eventId,
        sampleParticipantEmail(i).toLowerCase(),
        passwordHash,
        sampleParticipantDisplayName(i),
        'participant',
      ],
    )
  }

  let checkinCount = 0
  let ratingCount = 0
  let recommendationCount = 0
  let surveyAnswerCount = 0

  for (const userId of userIds) {
    const visitCount = randomInt(2, Math.min(8, boothIds.length))
    const visitedBooths = pickMany(boothIds, visitCount)
    let hourOffset = randomInt(1, 48)

    for (const boothId of visitedBooths) {
      const checkinId = randomUUID()
      const method = Math.random() > 0.35 ? 'qr' : 'manual'
      const checkedInAt = hoursAgo(hourOffset)
      hourOffset -= randomInt(0, 2)

      await db.execute(
        `INSERT INTO check_ins (id, user_id, booth_id, event_id, checkin_method, checked_in_at)
         VALUES (?,?,?,?,?,?)`,
        [checkinId, userId, boothId, eventId, method, checkedInAt],
      )
      checkinCount++

      if (Math.random() < 0.75) {
        await db.execute(
          `INSERT INTO booth_ratings (id, user_id, booth_id, event_id, checkin_id, rating)
           VALUES (?,?,?,?,?,?)`,
          [randomUUID(), userId, boothId, eventId, checkinId, randomInt(3, 5)],
        )
        ratingCount++
      }
    }

    const recCount = randomInt(2, 3)
    for (let r = 0; r < recCount; r++) {
      const offered = pickMany(boothIds, randomInt(3, 5))
      const selected = Math.random() < 0.82 ? pick(offered) : null
      await db.execute(
        `INSERT INTO recommendations (id, user_id, event_id, offered_booth_ids, selected_booth_id, algorithm, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          randomUUID(),
          userId,
          eventId,
          JSON.stringify(offered),
          selected,
          Math.random() > 0.3 ? 'mab' : 'random',
          hoursAgo(randomInt(1, 72)),
        ],
      )
      recommendationCount++
    }

    const customAnswers: Record<string, string> = {}
    for (const qid of questionIds) {
      customAnswers[qid] = pick(['A', 'B', 'C', 'D'])
    }
    await db.execute(
      `INSERT INTO user_survey_answers (id, user_id, event_id, age_range, occupation, industry, custom_answers)
       VALUES (?,?,?,?,?,?,?)`,
      [
        randomUUID(),
        userId,
        eventId,
        pick(AGE_RANGES),
        pick(OCCUPATIONS),
        pick(INDUSTRIES),
        JSON.stringify(customAnswers),
      ],
    )
    surveyAnswerCount++
  }

  return {
    categories: categoryCount,
    booths: boothCount,
    participants: participantCount,
    checkins: checkinCount,
    ratings: ratingCount,
    recommendations: recommendationCount,
    survey_answers: surveyAnswerCount,
    survey_questions: surveyQuestions.length,
  }
}
