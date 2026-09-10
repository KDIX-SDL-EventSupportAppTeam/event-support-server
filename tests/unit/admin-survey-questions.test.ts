import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { adminSurveyQuestionRoutes } from '../../src/routes/v1/admin/survey-questions.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '20000000-0000-4000-8000-000000000001'
const QUESTION_ID = '30000000-0000-4000-8000-000000000001'

const config = {
  port: 3000,
  databaseUrl: 'mysql://test',
  sakuraProxyUrl: undefined,
  sakuraProxyKey: undefined,
  jwtSecret: JWT_SECRET,
  webhookApiKey: '',
  recommenderUrl: '',
  recommenderTimeoutMs: 1500,
  checkinCooldownSec: 0,
  ratingScale: 3,
  corsOrigin: 'http://localhost:5173',
  adminRegistrationKey: 'k',
  frontendBaseUrl: 'https://front.example',
  organizerRegistrationKey: undefined,
  organizerSignupMode: 'invite',
} satisfies AppConfig

type StoredRow = {
  id: string
  question_text: string
  options: string | unknown
  display_order: number | null
  is_required: number | boolean | null
  question_key: string | null
  answer_type: string | null
}

/**
 * survey_questions を 1 テーブルだけ持つ DbClient モック。
 * INSERT / UPDATE のパラメータを保持し、GET と同じ経路で読み戻せるようにする。
 */
function makeDb(initial: StoredRow[] = []) {
  const rows: StoredRow[] = [...initial]
  const inserts: unknown[][] = []

  const run = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/SELECT id FROM survey_questions\s+WHERE event_id = \? AND question_key = \?/.test(sql)) {
      const [, key, excludeId] = params as [string, string, string]
      return [rows.filter((r) => r.question_key === key && r.id !== excludeId), undefined]
    }
    if (/SELECT id FROM survey_questions WHERE id = \? AND event_id = \?/.test(sql)) {
      return [rows.filter((r) => r.id === params[0]), undefined]
    }
    if (/SELECT id, question_text, options, display_order, is_required, question_key, answer_type/.test(sql)) {
      if (/WHERE id = \?/.test(sql)) return [rows.filter((r) => r.id === params[0]), undefined]
      return [rows, undefined]
    }
    if (/INSERT INTO survey_questions/.test(sql)) {
      inserts.push(params)
      const [id, , question_text, options, display_order, is_required, question_key, answer_type] =
        params as [string, string, string, string, number | null, boolean, string | null, string]
      rows.push({ id, question_text, options, display_order, is_required, question_key, answer_type })
      return [{ affectedRows: 1 }, undefined]
    }
    if (/UPDATE survey_questions SET/.test(sql)) {
      const target = rows.find((r) => r.id === params[params.length - 2])
      const setNames = (sql.match(/SET (.*) WHERE/)?.[1] ?? '')
        .split(',')
        .map((f) => f.trim().split(' ')[0])
      setNames.forEach((name, i) => {
        ;(target as unknown as Record<string, unknown>)[name] = params[i]
      })
      return [{ affectedRows: 1 }, undefined]
    }
    if (/INSERT INTO audit_logs/.test(sql)) return [{ affectedRows: 1 }, undefined]
    throw new Error(`unmatched SQL: ${sql}`)
  }

  const db = { query: run, execute: run, end: async () => {} } as DbClient
  return { db, rows, inserts }
}

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(
    async (v1) => {
      await v1.register(adminSurveyQuestionRoutes)
    },
    { prefix: '/api/v1' },
  )
  await app.ready()
  return app
}

const managerAuth = () => ({
  authorization: `Bearer ${jwt.sign(
    { sub: 'mgr-1', event_id: EVENT_ID, display_name: '', role: 'manager' },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  )}`,
  'content-type': 'application/json',
})

const BASE = `/api/v1/admin/events/${EVENT_ID}/survey-questions`

describe('POST /admin/events/:event_id/survey-questions', () => {
  it('question_key / answer_type / {value,label} 形式の options を保存して返す', async () => {
    const { db, inserts } = makeDb()
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      headers: managerAuth(),
      payload: {
        question_text: '年代を教えてください',
        question_key: 'age_range',
        answer_type: 'single',
        is_required: true,
        display_order: 3,
        options: [
          { value: 'teens', label: '10代' },
          { value: 'twenties', label: '20代' },
        ],
      },
    })
    expect(res.statusCode).toBe(201)
    const { question } = res.json().data
    expect(question.question_key).toBe('age_range')
    expect(question.answer_type).toBe('single')
    expect(question.options).toEqual([
      { value: 'teens', label: '10代' },
      { value: 'twenties', label: '20代' },
    ])
    // DB へも question_key / answer_type が書かれていること（NULL のままだと分析から見えない）
    expect(inserts[0][6]).toBe('age_range')
    expect(inserts[0][7]).toBe('single')
    await app.close()
  })

  it('multi の設問を作れる（interest_categories を運営画面から登録できる）', async () => {
    const { db } = makeDb()
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      headers: managerAuth(),
      payload: {
        question_text: '興味のある分野',
        question_key: 'interest_categories',
        answer_type: 'multi',
        options: ['ダミー'],
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.question.answer_type).toBe('multi')
    await app.close()
  })

  it('旧形式の string[] options も受け付け、{value,label} に正規化して保存する', async () => {
    const { db, inserts } = makeDb()
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      headers: managerAuth(),
      payload: { question_text: '満足度は？', options: ['満足', '不満'] },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.question.options).toEqual([
      { value: '満足', label: '満足' },
      { value: '不満', label: '不満' },
    ])
    expect(JSON.parse(inserts[0][3] as string)).toEqual([
      { value: '満足', label: '満足' },
      { value: '不満', label: '不満' },
    ])
    await app.close()
  })

  it('question_key を省略すると NULL のまま保存できる（既存の運営画面を壊さない）', async () => {
    const { db, inserts } = makeDb()
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      headers: managerAuth(),
      payload: { question_text: '自由記述', options: ['a'] },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.question.question_key).toBeNull()
    expect(res.json().data.question.answer_type).toBe('single')
    expect(inserts[0][6]).toBeNull()
    await app.close()
  })

  it('同一イベント内で question_key が重複すると422', async () => {
    const { db } = makeDb([
      {
        id: QUESTION_ID,
        question_text: '年代',
        options: '[]',
        display_order: 1,
        is_required: 1,
        question_key: 'age_range',
        answer_type: 'single',
      },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      headers: managerAuth(),
      payload: { question_text: '年代（重複）', question_key: 'age_range', options: ['a'] },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    await app.close()
  })

  it('question_key が NULL の設問は何件あっても重複扱いにならない', async () => {
    const { db } = makeDb([
      {
        id: QUESTION_ID,
        question_text: 'キー無し',
        options: '[]',
        display_order: 1,
        is_required: 0,
        question_key: null,
        answer_type: 'single',
      },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      headers: managerAuth(),
      payload: { question_text: 'キー無し2', options: ['a'] },
    })
    expect(res.statusCode).toBe(201)
    await app.close()
  })

  it('answer_type が3値以外だと422', async () => {
    const { db } = makeDb()
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      headers: managerAuth(),
      payload: { question_text: 'x', answer_type: 'checkbox', options: ['a'] },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })
})

describe('GET /admin/events/:event_id/survey-questions', () => {
  it('question_key / answer_type を含め、旧形式の options を正規化して返す', async () => {
    const { db } = makeDb([
      {
        id: QUESTION_ID,
        question_text: '満足度は？',
        options: '["満足","不満"]',
        display_order: 1,
        is_required: 1,
        question_key: null,
        answer_type: null,
      },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'GET', url: BASE, headers: managerAuth() })
    expect(res.statusCode).toBe(200)
    const [q] = res.json().data.questions
    expect(q.options).toEqual([
      { value: '満足', label: '満足' },
      { value: '不満', label: '不満' },
    ])
    expect(q.question_key).toBeNull()
    // answer_type が NULL の旧データは single として扱う
    expect(q.answer_type).toBe('single')
    await app.close()
  })
})

describe('PATCH /admin/events/:event_id/survey-questions/:question_id', () => {
  const existing = (): StoredRow => ({
    id: QUESTION_ID,
    question_text: '年代',
    options: '["10代"]',
    display_order: 1,
    is_required: 0,
    question_key: null,
    answer_type: null,
  })

  it('question_key と answer_type を後から付けられる', async () => {
    const { db } = makeDb([existing()])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/${QUESTION_ID}`,
      headers: managerAuth(),
      payload: { question_key: 'age_range', answer_type: 'single' },
    })
    expect(res.statusCode).toBe(200)
    const { question } = res.json().data
    expect(question.question_key).toBe('age_range')
    expect(question.answer_type).toBe('single')
    await app.close()
  })

  it('旧形式の options で更新しても正規化して保存する', async () => {
    const { db, rows } = makeDb([existing()])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/${QUESTION_ID}`,
      headers: managerAuth(),
      payload: { options: ['20代', '30代'] },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(rows[0].options as string)).toEqual([
      { value: '20代', label: '20代' },
      { value: '30代', label: '30代' },
    ])
    await app.close()
  })

  it('他の設問が使っている question_key へは変更できない（422）', async () => {
    const { db } = makeDb([
      existing(),
      {
        id: '30000000-0000-4000-8000-000000000002',
        question_text: '職業',
        options: '[]',
        display_order: 2,
        is_required: 1,
        question_key: 'occupation',
        answer_type: 'single',
      },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/${QUESTION_ID}`,
      headers: managerAuth(),
      payload: { question_key: 'occupation' },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('自分自身と同じ question_key への更新は重複扱いにしない', async () => {
    const row = existing()
    row.question_key = 'age_range'
    const { db } = makeDb([row])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/${QUESTION_ID}`,
      headers: managerAuth(),
      payload: { question_key: 'age_range', question_text: '年代を教えてください' },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})
