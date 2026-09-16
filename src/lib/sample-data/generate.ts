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

/**
 * 本番の設問セット（db/migrations/16_pre_survey_questions.sql）と同じ設問・同じ離散コードで
 * 生成する。生成データで推薦経路をそのまま検証できるようにするため、
 * 値は日本語ラベルではなく `value` 側のコードを入れる。
 */
const PRE_SURVEY_QUESTIONS: {
  question_key: string
  question_text: string
  answer_type: 'single' | 'multi' | 'text'
  is_required: boolean
  options: { value: string; label: string }[]
}[] = [
  {
    question_key: 'interest_categories',
    question_text: '興味のある分野を選んでください（複数選択可）',
    answer_type: 'multi',
    is_required: true,
    options: [], // 配信時に categories から生成する（P-10）
  },
  {
    question_key: 'top_interest_category',
    question_text: 'その中で、一番興味がある分野を1つ選んでください',
    answer_type: 'single',
    is_required: true,
    options: [], // 同上
  },
  {
    question_key: 'age_range',
    question_text: '年代を教えてください',
    answer_type: 'single',
    is_required: true,
    options: [
      { value: 'teens', label: '10代' },
      { value: 'twenties', label: '20代' },
      { value: 'thirties', label: '30代' },
      { value: 'forties', label: '40代' },
      { value: 'fifties_plus', label: '50代以上' },
    ],
  },
  {
    question_key: 'occupation',
    question_text: 'ご職業を教えてください',
    answer_type: 'single',
    is_required: true,
    options: [
      { value: 'student', label: '学生' },
      { value: 'engineer', label: 'エンジニア' },
      { value: 'designer', label: 'デザイナー' },
      { value: 'planner', label: '企画・営業' },
      { value: 'other', label: 'その他' },
    ],
  },
  {
    question_key: 'gender',
    question_text: '性別を教えてください（任意）',
    answer_type: 'single',
    is_required: false,
    options: [
      { value: 'male', label: '男性' },
      { value: 'female', label: '女性' },
      { value: 'other', label: 'その他' },
      { value: 'prefer_not_to_say', label: '回答しない' },
    ],
  },
  {
    question_key: 'exploration_disposition',
    question_text: '知らない分野のブースも見てみたいですか',
    answer_type: 'single',
    is_required: true,
    options: [
      { value: 'high', label: '積極的に見たい' },
      { value: 'mid', label: 'どちらともいえない' },
      { value: 'low', label: '興味のある分野を中心に回りたい' },
    ],
  },
]

/** 配信時に categories から選択肢が作られる設問（options を保存しない）。 */
const CATEGORY_DERIVED_KEYS = new Set(['interest_categories', 'top_interest_category'])

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

/**
 * 複数行を1つの INSERT にまとめて実行する（1件ずつ往復するとさくらプロキシへの
 * HTTP 往復が数百回になり遅い／タイムアウトしやすいため）。
 * プレースホルダ過多を避けるため BULK_CHUNK_ROWS 行ごとに分割する。
 */
const BULK_CHUNK_ROWS = 100
async function bulkInsert(
  db: DbClient,
  prefix: string,
  columnsPerRow: number,
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return
  const rowPlaceholder = `(${Array(columnsPerRow).fill('?').join(',')})`
  for (let i = 0; i < rows.length; i += BULK_CHUNK_ROWS) {
    const chunk = rows.slice(i, i + BULK_CHUNK_ROWS)
    const values = Array(chunk.length).fill(rowPlaceholder).join(',')
    await db.execute(prefix + values, chunk.flat())
  }
}

export type SampleGenerateResult = {
  categories: number
  booths: number
  participants: number
  checkins: number
  ratings: number
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

  // --- カテゴリ ---
  const categoryIds: string[] = []
  const categoryRows: unknown[][] = []
  for (let i = 1; i <= categoryCount; i++) {
    const id = randomUUID()
    categoryIds.push(id)
    categoryRows.push([id, eventId, sampleCategoryName(i)])
  }
  await bulkInsert(db, `INSERT INTO categories (id, event_id, name) VALUES `, 3, categoryRows)

  // --- ブース（+ タグ・カテゴリ紐付け） ---
  const boothIds: string[] = []
  const boothRows: unknown[][] = []
  const boothCategoryRows: unknown[][] = []
  const boothTagRows: unknown[][] = []
  for (let i = 1; i <= boothCount; i++) {
    const id = randomUUID()
    boothIds.push(id)
    const boothCategories = pickMany(categoryIds, randomInt(2, 4))
    boothRows.push([
      id,
      eventId,
      sampleBoothName(i),
      `${SAMPLE_PREFIX} デモ用ブースです（分析・チェックイン確認用）`,
      boothCategories[0],
      sampleManualCode(i),
    ])
    if (hasBoothCategories) {
      for (const catId of boothCategories) {
        boothCategoryRows.push([id, catId])
      }
    }
    boothTagRows.push([randomUUID(), id, SAMPLE_PREFIX])
    boothTagRows.push([randomUUID(), id, 'デモ'])
  }
  await bulkInsert(
    db,
    `INSERT INTO booths (id, event_id, name, description, category_id, manual_code) VALUES `,
    6,
    boothRows,
  )
  if (hasBoothCategories) {
    await bulkInsert(
      db,
      `INSERT INTO booth_categories (booth_id, category_id) VALUES `,
      2,
      boothCategoryRows,
    )
  }
  await bulkInsert(db, `INSERT INTO booth_tags (id, booth_id, tag) VALUES `, 3, boothTagRows)

  // --- アンケート設問（本番の設問セットと同じ6問） ---
  // 16_pre_survey_questions.sql を流した後のイベントでは既に同じ question_key の設問がある。
  // question_key はイベント内で一意でなければ分析が設問を特定できないため、
  // 足りないものだけを入れる（INSERT の前に SELECT で確認する。ADR 0001）。
  const [existingKeyRows] = await db.query(
    'SELECT question_key FROM survey_questions WHERE event_id = ? AND question_key IS NOT NULL',
    [eventId],
  )
  const existingKeys = new Set(
    (existingKeyRows as { question_key: string }[]).map((r) => r.question_key),
  )
  const questionRows: unknown[][] = []
  for (const [idx, q] of PRE_SURVEY_QUESTIONS.entries()) {
    if (existingKeys.has(q.question_key)) continue
    questionRows.push([
      randomUUID(),
      eventId,
      // clearSampleData は question_text の接頭辞で消す設問を選ぶ。接頭辞を外すと
      // サンプル生成した設問が消えずに残るため、表示文言側にだけ接頭辞を付ける。
      // question_key / answer_type / options の value は本番と同じ契約値のままにする。
      `${SAMPLE_PREFIX} ${q.question_text}`,
      JSON.stringify(q.options),
      idx + 1,
      q.is_required ? 1 : 0,
      q.question_key,
      q.answer_type,
    ])
  }
  await bulkInsert(
    db,
    `INSERT INTO survey_questions
       (id, event_id, question_text, options, display_order, is_required, question_key, answer_type) VALUES `,
    8,
    questionRows,
  )

  // --- 参加者 ---
  const passwordHash = await bcrypt.hash(SAMPLE_USER_PASSWORD, 10)
  const userIds: string[] = []
  const userRows: unknown[][] = []
  for (let i = 1; i <= participantCount; i++) {
    const id = randomUUID()
    userIds.push(id)
    userRows.push([
      id,
      eventId,
      sampleParticipantEmail(i).toLowerCase(),
      passwordHash,
      sampleParticipantDisplayName(i),
      'participant',
    ])
  }
  await bulkInsert(
    db,
    `INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES `,
    6,
    userRows,
  )

  // --- チェックイン・評価・アンケート回答 ---
  // 推薦データ（recommendation_scores）はサンプル生成で作らない。解放処理の副産物であり、
  // card_unlock_events の捏造が必要になるため（仕様書 §4-C）。
  const checkinRows: unknown[][] = []
  const ratingRows: unknown[][] = []
  const surveyAnswerRows: unknown[][] = []

  for (const userId of userIds) {
    const visitCount = randomInt(2, Math.min(8, boothIds.length))
    const visitedBooths = pickMany(boothIds, visitCount)
    let hourOffset = randomInt(1, 48)

    for (const boothId of visitedBooths) {
      const checkinId = randomUUID()
      const method = Math.random() > 0.35 ? 'qr' : 'manual'
      const checkedInAt = hoursAgo(hourOffset)
      hourOffset -= randomInt(0, 2)
      checkinRows.push([checkinId, userId, boothId, eventId, method, checkedInAt])

      if (Math.random() < 0.75) {
        ratingRows.push([randomUUID(), userId, boothId, eventId, checkinId, randomInt(3, 5)])
      }
    }

    // custom_answers のキーは設問 UUID ではなく question_key。分析・推薦はこちらで設問を特定する。
    const interestCategories = pickMany(categoryIds, randomInt(1, Math.min(3, categoryIds.length)))
    const customAnswers: Record<string, string | string[]> = {
      interest_categories: interestCategories,
      // 第1希望は必ず interest_categories の中から選ぶ（survey.ts の包含チェックと同じ制約）
      top_interest_category: pick(interestCategories),
    }
    for (const q of PRE_SURVEY_QUESTIONS) {
      if (CATEGORY_DERIVED_KEYS.has(q.question_key)) continue
      customAnswers[q.question_key] = pick(q.options).value
    }
    surveyAnswerRows.push([
      randomUUID(),
      userId,
      eventId,
      customAnswers.age_range as string,
      customAnswers.occupation as string,
      null, // industry: 本番の設問セットに業種は無い
      JSON.stringify(customAnswers),
    ])
  }

  await bulkInsert(
    db,
    `INSERT INTO check_ins (id, user_id, booth_id, event_id, checkin_method, checked_in_at) VALUES `,
    6,
    checkinRows,
  )
  await bulkInsert(
    db,
    `INSERT INTO booth_ratings (id, user_id, booth_id, event_id, checkin_id, rating) VALUES `,
    6,
    ratingRows,
  )
  await bulkInsert(
    db,
    `INSERT INTO user_survey_answers (id, user_id, event_id, age_range, occupation, industry, custom_answers) VALUES `,
    7,
    surveyAnswerRows,
  )

  return {
    categories: categoryCount,
    booths: boothCount,
    participants: participantCount,
    checkins: checkinRows.length,
    ratings: ratingRows.length,
    survey_answers: surveyAnswerRows.length,
    survey_questions: questionRows.length,
  }
}
