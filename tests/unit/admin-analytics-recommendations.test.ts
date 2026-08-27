import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { adminAnalyticsRoutes } from '../../src/routes/v1/admin/analytics.js'

/**
 * 運営分析の推薦集計が recommendation_scores へ移ったあとも、
 * **応答の形（フィールド名・型・null 許容）が変わっていない**ことを守るテスト。
 * フロント（event-support-frontend）を無改修で復旧させるための契約であり、
 * ここが崩れるとフロントが壊れる。docs/specs/migration-09-followup/README.md §5。
 */

const JWT_SECRET = 'test-secret'
const EVENT_ID = '20000000-0000-4000-8000-000000000001'

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

type Handler = { match: RegExp; rows: unknown[] }

function makeDb(handlers: Handler[], log?: string[]): DbClient {
  const run = async (sql: string, params: unknown[] = []) => {
    log?.push(sql)
    const h = handlers.find((x) => x.match.test(sql))
    if (!h) throw new Error(`unmatched SQL: ${sql}`)
    return [h.rows, undefined] as [unknown, unknown]
  }
  return { query: run, execute: run, end: async () => {} }
}

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(async (v1) => { await v1.register(adminAnalyticsRoutes) }, { prefix: '/api/v1' })
  await app.ready()
  return app
}

const managerAuth = () => ({
  authorization: `Bearer ${jwt.sign(
    { sub: 'mgr-1', event_id: EVENT_ID, display_name: '運営', role: 'manager' },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  )}`,
})

// --- 各ルートが引く SQL のモック ---------------------------------------------
const scoreRows = [
  { unlock_event_id: 'ue1', booth_id: 'b-1', was_assigned: 1, user_id: 'u1', created_at: '2026-08-27 10:00:00', strategy: 'mab' },
  { unlock_event_id: 'ue1', booth_id: 'b-2', was_assigned: 0, user_id: 'u1', created_at: '2026-08-27 10:00:00', strategy: 'mab' },
]
const recScores = (rows: unknown[] = scoreRows): Handler => ({
  match: /FROM recommendation_scores/,
  rows,
})
// b-3 は一度も推薦候補に挙がっていないブース（acceptance_rate が null になる）
const booths: Handler = {
  match: /FROM booths b\s+LEFT JOIN categories/,
  rows: [
    { id: 'b-1', name: 'ブースA', manual_code: 'A01', created_at: '2026-08-27 09:00:00', category_id: null, category_name: null, checkin_count: 2, qr_count: 2, manual_count: 0 },
    { id: 'b-3', name: 'ブースC', manual_code: 'A03', created_at: '2026-08-27 09:00:00', category_id: null, category_name: null, checkin_count: 0, qr_count: 0, manual_count: 0 },
  ],
}
const boothTags: Handler = { match: /FROM booth_tags bt/, rows: [] }
const ratings: Handler = { match: /FROM booth_ratings/, rows: [] }
const boothNames: Handler = { match: /SELECT id, name FROM booths/, rows: [{ id: 'b-1', name: 'ブースA' }, { id: 'b-2', name: 'ブースB' }] }
const checkins = (rows: unknown[] = []): Handler => ({ match: /FROM check_ins/, rows })

const getBooths = (app: FastifyInstance) =>
  app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/analytics/booths`, headers: managerAuth() })
const getRecommendations = (app: FastifyInstance) =>
  app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/analytics/recommendations`, headers: managerAuth() })

describe('GET /admin/events/:event_id/analytics/booths', () => {
  it('推薦3フィールドを recommendation_scores から埋め、型と null 許容を維持する', async () => {
    const app = await buildTestApp(makeDb([booths, boothTags, ratings, recScores()]))
    const res = await getBooths(app)

    expect(res.statusCode).toBe(200)
    const list = res.json().data.booths as Record<string, unknown>[]
    const b1 = list.find((b) => b.id === 'b-1')!
    expect(b1.recommendation_offered_count).toBe(1)
    expect(b1.recommendation_selected_count).toBe(1)
    // フロントは `!= null` で分岐する。number であること
    expect(b1.recommendation_acceptance_rate).toBe(100)
    expect(typeof b1.recommendation_acceptance_rate).toBe('number')
    await app.close()
  })

  it('候補に挙がっていないブースの acceptance_rate は null（0 に潰さない）', async () => {
    const app = await buildTestApp(makeDb([booths, boothTags, ratings, recScores()]))
    const res = await getBooths(app)

    const b3 = (res.json().data.booths as Record<string, unknown>[]).find((b) => b.id === 'b-3')!
    expect(b3.recommendation_offered_count).toBe(0)
    expect(b3.recommendation_selected_count).toBe(0)
    expect(b3.recommendation_acceptance_rate).toBeNull()
    await app.close()
  })

  it('推薦データが 0 件でも 500 にならず、他の集計は返る', async () => {
    const app = await buildTestApp(makeDb([booths, boothTags, ratings, recScores([])]))
    const res = await getBooths(app)

    expect(res.statusCode).toBe(200)
    const b1 = (res.json().data.booths as Record<string, unknown>[])[0]
    expect(b1.recommendation_offered_count).toBe(0)
    expect(b1.recommendation_acceptance_rate).toBeNull()
    expect(b1.checkin_count).toBe(2)
    await app.close()
  })

  it('起きてはいけないこと: 廃止された recommendations テーブルを引く', async () => {
    const log: string[] = []
    const app = await buildTestApp(makeDb([booths, boothTags, ratings, recScores()], log))
    await getBooths(app)

    expect(log.some((sql) => /\brecommendations\b/.test(sql))).toBe(false)
    expect(log.some((sql) => /FROM recommendation_scores/.test(sql))).toBe(true)
    await app.close()
  })
})

describe('GET /admin/events/:event_id/analytics/recommendations', () => {
  it('summary の形を維持する（acceptance_rate は number、algorithm は strategy 由来）', async () => {
    const app = await buildTestApp(makeDb([recScores(), boothNames, checkins()]))
    const res = await getRecommendations(app)

    expect(res.statusCode).toBe(200)
    const { summary } = res.json().data
    expect(summary).toEqual({
      total_recommendations: 2,
      selected_count: 1,
      acceptance_rate: 50,
      open_count: 1,
      algorithm: 'mab',
    })
    expect(typeof summary.acceptance_rate).toBe('number')
    await app.close()
  })

  it('by_booth をブース単位で集計し、ブース名を解決する', async () => {
    const app = await buildTestApp(makeDb([recScores(), boothNames, checkins()]))
    const res = await getRecommendations(app)

    const byBooth = res.json().data.by_booth as Record<string, unknown>[]
    expect(byBooth).toEqual([
      { booth_id: 'b-1', booth_name: 'ブースA', offered_count: 1, selected_count: 1, acceptance_rate: 100 },
      { booth_id: 'b-2', booth_name: 'ブースB', offered_count: 1, selected_count: 0, acceptance_rate: 0 },
    ])
    await app.close()
  })

  it('割り当て後のチェックインを conversion として数える', async () => {
    const app = await buildTestApp(
      makeDb([
        recScores(),
        boothNames,
        // b-1 は推薦の 30 分後に訪問、b-2 は割り当てなしなので対象外
        checkins([{ user_id: 'u1', booth_id: 'b-1', checked_in_at: '2026-08-27 10:30:00' }]),
      ]),
    )
    const res = await getRecommendations(app)

    expect(res.json().data.conversion).toEqual({
      selected_then_checkedin: 1,
      selected_total: 1,
      conversion_rate: 100,
      avg_minutes_to_checkin: 30,
    })
    await app.close()
  })

  it('起きてはいけないこと: 推薦より前のチェックインを conversion に数える', async () => {
    const app = await buildTestApp(
      makeDb([
        recScores(),
        boothNames,
        checkins([{ user_id: 'u1', booth_id: 'b-1', checked_in_at: '2026-08-27 09:00:00' }]),
      ]),
    )
    const res = await getRecommendations(app)

    const { conversion } = res.json().data
    expect(conversion.selected_then_checkedin).toBe(0)
    expect(conversion.avg_minutes_to_checkin).toBeNull()
    await app.close()
  })

  it('推薦データが 0 件でも 500 にならず、既定値で返る（サンプル投入時の状態）', async () => {
    const app = await buildTestApp(makeDb([recScores([]), boothNames, checkins()]))
    const res = await getRecommendations(app)

    expect(res.statusCode).toBe(200)
    const { summary, by_booth, conversion } = res.json().data
    expect(summary.total_recommendations).toBe(0)
    // フロントは number 前提で表示する。null にしない
    expect(summary.acceptance_rate).toBe(0)
    expect(summary.algorithm).toBe('mab')
    expect(by_booth).toEqual([])
    expect(conversion.conversion_rate).toBeNull()
    await app.close()
  })

  it('起きてはいけないこと: 廃止された recommendations テーブルを引く', async () => {
    const log: string[] = []
    const app = await buildTestApp(makeDb([recScores(), boothNames, checkins()], log))
    await getRecommendations(app)

    expect(log.some((sql) => /\brecommendations\b/.test(sql))).toBe(false)
    await app.close()
  })

  it('参加者ロールでは参照できない', async () => {
    const app = await buildTestApp(makeDb([recScores(), boothNames, checkins()]))
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/analytics/recommendations`,
      headers: {
        authorization: `Bearer ${jwt.sign(
          { sub: 'p-1', event_id: EVENT_ID, display_name: '参加者', role: 'participant' },
          JWT_SECRET,
          { algorithm: 'HS256', expiresIn: '1h' },
        )}`,
      },
    })

    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    await app.close()
  })
})
