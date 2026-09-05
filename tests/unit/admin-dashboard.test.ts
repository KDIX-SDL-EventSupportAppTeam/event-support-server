import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { adminRoutes } from '../../src/routes/v1/admin/dashboard.js'

/**
 * docs/specs/recommender-phase-linkage/10-testing.md T-12〜T-21
 *
 * ダッシュボードは推薦エンジンの独自フェーズ計算を廃止し、DB の事実だけを返す。
 */
const JWT_SECRET = 'test-secret'
const EVENT_ID = '20000000-0000-4000-8000-000000000001'

const config = {
  port: 3000,
  databaseUrl: 'mysql://test',
  jwtSecret: JWT_SECRET,
  webhookApiKey: '',
  recommenderUrl: '',
  recommenderTimeoutMs: 1500,
  recommenderOpsToken: '',
  recommenderStateTimeoutMs: 2000,
  checkinCooldownSec: 0,
  ratingScale: 4,
  corsOrigin: 'http://localhost:5173',
  adminRegistrationKey: 'k',
  organizerSignupMode: 'invite',
} as unknown as AppConfig

type Handler = { match: RegExp; rows: unknown[] }

function makeDb(handlers: Handler[], log?: string[]): DbClient {
  const run = async (sql: string) => {
    log?.push(sql)
    const h = handlers.find((x) => x.match.test(sql))
    if (!h) throw new Error(`unmatched SQL: ${sql}`)
    return [h.rows, undefined] as [unknown, unknown]
  }
  return { query: run, execute: run, end: async () => {} }
}

/** pair_count の配列から r6 の行を作る。 */
function pairRows(counts: number[]): unknown[] {
  return counts.map((c, i) => ({ card_id: `card-${i}`, pair_count: c }))
}

function baseHandlers(over: Partial<Record<'r5' | 'r6' | 'r7', unknown[]>> = {}): Handler[] {
  return [
    { match: /AS c FROM users WHERE event_id/, rows: [{ c: 10 }] },
    { match: /AS c FROM check_ins WHERE event_id/, rows: [{ c: 25 }] },
    { match: /FROM booths b/, rows: [] },
    { match: /time_slot/, rows: [] },
    {
      match: /u\.role = 'participant'\) AS ratings/,
      rows: over.r5 ?? [{ checkins: 20, ratings: 12 }],
    },
    { match: /AS pair_count/, rows: over.r6 ?? pairRows([]) },
    {
      match: /FALLBACK_COVERAGE/,
      rows: over.r7 ?? [{ fallback_count: 1, total_count: 4 }],
    },
  ]
}

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(async (v1) => { await v1.register(adminRoutes) }, { prefix: '/api/v1' })
  await app.ready()
  return app
}

function managerAuth() {
  return {
    authorization: `Bearer ${jwt.sign(
      { sub: 'mgr', event_id: EVENT_ID, role: 'manager', display_name: '' },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    )}`,
  }
}

async function getDashboard(handlers: Handler[], log?: string[]) {
  const app = await buildTestApp(makeDb(handlers, log))
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/events/${EVENT_ID}/dashboard`,
    headers: managerAuth(),
  })
  await app.close()
  return res
}

describe('GET /admin/events/:event_id/dashboard（フェーズ計算の廃止）', () => {
  it('T-12 応答に bingo.recommender.current_phase が含まれない', async () => {
    const res = await getDashboard(baseHandlers())
    expect(res.statusCode).toBe(200)
    const { bingo } = res.json().data
    expect(bingo.recommender).toBeUndefined()
    expect(JSON.stringify(bingo)).not.toContain('current_phase')
  })

  it('T-13 rating_collection_rate / unlocks / fallback_rate_last_30min は従来どおり返る', async () => {
    const res = await getDashboard(baseHandlers())
    const { bingo } = res.json().data
    expect(bingo.rating_collection_rate).toBe(0.6) // 12 / 20
    expect(bingo.unlocks).toEqual({ first: 0, second: 0, third: 0 })
    expect(bingo.fallback_rate_last_30min).toBe(0.25) // 1 / 4
    expect(bingo.checkins).toBe(20)
    expect(bingo.ratings).toBe(12)
  })

  it('T-14 推薦エンジンが落ちていても 200 で全項目を返す（そもそも呼ばない）', async () => {
    const res = await getDashboard(baseHandlers())
    expect(res.statusCode).toBe(200)
    const { summary, bingo } = res.json().data
    expect(summary.total_participants).toBe(10)
    expect(bingo).toHaveProperty('rating_collection_rate')
  })

  it('T-17 累計ペア数 1 → 1回目のみ', async () => {
    const res = await getDashboard(baseHandlers({ r6: pairRows([1]) }))
    expect(res.json().data.bingo.unlocks).toEqual({ first: 1, second: 0, third: 0 })
  })

  it('T-18 累計ペア数 3 → 1回目・2回目', async () => {
    const res = await getDashboard(baseHandlers({ r6: pairRows([3]) }))
    expect(res.json().data.bingo.unlocks).toEqual({ first: 1, second: 1, third: 0 })
  })

  it('T-19 累計ペア数 6 → 1回目・2回目・3回目', async () => {
    const res = await getDashboard(baseHandlers({ r6: pairRows([6]) }))
    expect(res.json().data.bingo.unlocks).toEqual({ first: 1, second: 1, third: 1 })
  })

  it('T-16 累計ペア数 0 のカードはどの回にも数えられない', async () => {
    const res = await getDashboard(baseHandlers({ r6: pairRows([0, 0]) }))
    expect(res.json().data.bingo.unlocks).toEqual({ first: 0, second: 0, third: 0 })
  })

  it('T-20 到達人数の集計 SQL は PRESURVEY を除外している', async () => {
    const log: string[] = []
    await getDashboard(baseHandlers(), log)
    const pairSql = log.find((s) => /AS pair_count/.test(s))!
    expect(pairSql).toMatch(/pair_key <> 'PRESURVEY'/)
  })

  it('T-21 到達人数の集計 SQL は participant のカードだけを数える（users を JOIN して role で絞る）', async () => {
    const log: string[] = []
    await getDashboard(baseHandlers(), log)
    const pairSql = log.find((s) => /AS pair_count/.test(s))!
    expect(pairSql).toMatch(/JOIN users u ON u\.id = k\.user_id AND u\.role = 'participant'/)
    // 評価回収率側も従来どおり participant に絞っている
    const ratingSql = log.find((s) => /AS ratings/.test(s))!
    expect(ratingSql).toMatch(/role = 'participant'/)
  })

  it('T-17〜T-19 補足: 人数は累積で first >= second >= third（1・3・6 ペアのカードが 1 枚ずつ）', async () => {
    const res = await getDashboard(baseHandlers({ r6: pairRows([1, 3, 6]) }))
    expect(res.json().data.bingo.unlocks).toEqual({ first: 3, second: 2, third: 1 })
  })
})
