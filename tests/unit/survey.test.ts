import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import Fastify, { type FastifyInstance } from 'fastify'
import type { DbClient } from '../../src/db/client.js'
import { surveyRoutes } from '../../src/routes/v1/survey.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const CAT_ID = '33333333-3333-4333-8333-333333333333'

const config = {
  port: 3000,
  jwtSecret: JWT_SECRET,
} as unknown as import('../../src/config.js').AppConfig

type Question = {
  id: string
  question_text: string
  options: unknown
  display_order: number | null
  is_required: number | boolean | null
  answer_type: 'single' | 'multi' | 'text' | null
  question_key: string | null
}

function makeDb(opts: {
  questions?: Question[]
  preSurveyClosesAt?: string | null
  accessMode?: string
  existingAnswerId?: string | null
}): DbClient {
  const questions: Question[] = opts.questions ?? [
    {
      id: 'q1',
      question_text: '年代',
      options: [{ value: 'twenties', label: '20代' }],
      display_order: 1,
      is_required: 1,
      answer_type: 'single',
      question_key: 'age_range',
    },
    {
      id: 'q2',
      question_text: '関心のある分野',
      options: null,
      display_order: 2,
      is_required: 1,
      answer_type: 'multi',
      question_key: 'interest_categories',
    },
  ]
  let existingAnswerId = opts.existingAnswerId ?? null
  let updateCalls = 0
  let insertCalls = 0

  const run = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/SELECT id FROM events WHERE id = \?/.test(sql)) {
      return [[{ id: params[0] }], undefined]
    }
    if (/SELECT event_id, mode, app_opens_at, app_closes_at, pre_survey_closes_at/.test(sql)) {
      return [
        [
          {
            event_id: EVENT_ID,
            mode: opts.accessMode ?? 'open',
            app_opens_at: null,
            app_closes_at: null,
            pre_survey_closes_at: opts.preSurveyClosesAt ?? null,
            updated_by: null,
            updated_at: '2026-08-24 00:00:00',
          },
        ],
        undefined,
      ]
    }
    if (/SELECT id, question_text, options, display_order, is_required, answer_type, question_key\s+FROM survey_questions/.test(sql)) {
      return [questions, undefined]
    }
    if (/SELECT id, name FROM categories WHERE event_id = \?/.test(sql)) {
      return [[{ id: CAT_ID, name: 'AI・機械学習' }], undefined]
    }
    if (/SELECT id FROM user_survey_answers WHERE user_id = \? AND event_id = \?/.test(sql)) {
      return [existingAnswerId ? [{ id: existingAnswerId }] : [], undefined]
    }
    if (/UPDATE user_survey_answers/.test(sql)) {
      updateCalls++
      return [{ affectedRows: 1 }, undefined]
    }
    if (/INSERT INTO user_survey_answers/.test(sql)) {
      insertCalls++
      existingAnswerId = 'new-answer-id'
      return [{ affectedRows: 1 }, undefined]
    }
    throw new Error(`unmatched SQL: ${sql} / ${JSON.stringify(params)}`)
  }
  const db = { query: run, execute: run, end: async () => {} } as DbClient
  Object.defineProperty(db, '_counts', { get: () => ({ updateCalls, insertCalls }) })
  return db
}

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(async (v1) => {
    await v1.register(surveyRoutes)
  }, { prefix: '/api/v1' })
  await app.ready()
  return app
}

function authHeader(): Record<string, string> {
  const token = jwt.sign(
    { sub: USER_ID, event_id: EVENT_ID, display_name: 'テスト太郎', role: 'participant' },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

describe('GET /events/:event_id/pre-survey/questions（公開）', () => {
  it('未ログインでも取得できる', async () => {
    const app = await buildTestApp(makeDb({}))
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${EVENT_ID}/pre-survey/questions` })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('interest_categories の選択肢が categories から生成される', async () => {
    const app = await buildTestApp(makeDb({}))
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${EVENT_ID}/pre-survey/questions` })
    const { data } = res.json()
    const q = data.questions.find((x: { question_key: string }) => x.question_key === 'interest_categories')
    expect(q.options).toEqual([{ value: CAT_ID, label: 'AI・機械学習' }])
    await app.close()
  })

  it('is_pre_survey_open を返す', async () => {
    const app = await buildTestApp(makeDb({ preSurveyClosesAt: '2020-01-01 00:00:00' }))
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${EVENT_ID}/pre-survey/questions` })
    expect(res.json().data.is_pre_survey_open).toBe(false)
    await app.close()
  })
})

describe('POST /events/:event_id/survey/answers', () => {
  it('締切後は409 PRE_SURVEY_CLOSED', async () => {
    const app = await buildTestApp(makeDb({ preSurveyClosesAt: '2020-01-01 00:00:00' }))
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/survey/answers`,
      headers: authHeader(),
      payload: { age_range: 'twenties', custom_answers: { interest_categories: [CAT_ID] } },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('PRE_SURVEY_CLOSED')
    await app.close()
  })

  it('必須設問が欠けていると400', async () => {
    const app = await buildTestApp(makeDb({}))
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/survey/answers`,
      headers: authHeader(),
      payload: { custom_answers: {} },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('options に無い value は400', async () => {
    const app = await buildTestApp(makeDb({}))
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/survey/answers`,
      headers: authHeader(),
      payload: { age_range: 'not-a-real-option', custom_answers: { interest_categories: [CAT_ID] } },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('answer_type と値の型が一致しないと400（multi に文字列を渡す）', async () => {
    const app = await buildTestApp(makeDb({}))
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/survey/answers`,
      headers: authHeader(),
      payload: { age_range: 'twenties', custom_answers: { interest_categories: CAT_ID } },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('正常送信で200になり answered_at を返す', async () => {
    const app = await buildTestApp(makeDb({}))
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/survey/answers`,
      headers: authHeader(),
      payload: { age_range: 'twenties', custom_answers: { interest_categories: [CAT_ID] } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.answered_at).toBeDefined()
    await app.close()
  })

  it('2回送信しても行が増えず UPDATE される（既存行あり）', async () => {
    const db = makeDb({ existingAnswerId: 'existing-id' })
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/survey/answers`,
      headers: authHeader(),
      payload: { age_range: 'twenties', custom_answers: { interest_categories: [CAT_ID] } },
    })
    expect(res.statusCode).toBe(200)
    expect((db as unknown as { _counts: { updateCalls: number; insertCalls: number } })._counts.updateCalls).toBe(1)
    expect((db as unknown as { _counts: { updateCalls: number; insertCalls: number } })._counts.insertCalls).toBe(0)
    await app.close()
  })
})
