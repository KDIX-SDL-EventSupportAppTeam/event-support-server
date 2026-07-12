import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { adminBoothRoutes, boothListQuery, SORT_SQL, DIR_SQL } from '../../src/routes/v1/admin/admin-booths.js'

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
  corsOrigin: 'http://localhost:5173',
  adminRegistrationKey: 'k',
  frontendBaseUrl: 'https://front.example',
  organizerRegistrationKey: undefined,
  organizerSignupMode: 'invite',
} satisfies AppConfig

type Handler = {
  match: RegExp
  rows: unknown[] | ((params: unknown[]) => unknown[])
}

/** SQL 文字列をパターン照合して結果を返す DbClient モック（tests/unit/exhibitor.test.ts と同じ流儀）。 */
function makeDb(handlers: Handler[], log?: string[]): DbClient {
  const run = async (sql: string, params: unknown[] = []) => {
    log?.push(sql)
    const h = handlers.find((x) => x.match.test(sql))
    if (!h) throw new Error(`unmatched SQL: ${sql}`)
    const rows = typeof h.rows === 'function' ? h.rows(params) : h.rows
    return [rows, undefined] as [unknown, unknown]
  }
  return { query: run, execute: run, end: async () => {} }
}

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(
    async (v1) => {
      await v1.register(adminBoothRoutes)
    },
    { prefix: '/api/v1' },
  )
  await app.ready()
  return app
}

function signToken(payload: { sub: string; event_id: string; display_name?: string; role?: string }): string {
  return jwt.sign(
    { display_name: '', ...payload },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  )
}
const managerAuth = () => ({
  authorization: `Bearer ${signToken({ sub: 'mgr-1', event_id: EVENT_ID, role: 'manager' })}`,
})
const viewerAuth = () => ({
  authorization: `Bearer ${signToken({ sub: 'vwr-1', event_id: EVENT_ID, role: 'viewer' })}`,
})
const participantAuth = () => ({
  authorization: `Bearer ${signToken({ sub: 'p-1', event_id: EVENT_ID, role: 'participant' })}`,
})

const boothRows = [
  { id: 'b-1', name: 'ブースA', checkin_count: 42, avg_rating: 4.256, comment_count: 15 },
  { id: 'b-2', name: 'ブースB', checkin_count: 10, avg_rating: null, comment_count: 0 },
]

describe('boothListQuery / SORT_SQL 単体（#55 §4-2）', () => {
  it('未指定時は既定値 {checkin_count, desc}', () => {
    const parsed = boothListQuery.safeParse({})
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({ sort: 'checkin_count', order: 'desc' })
    }
  })

  it('sort=name&order=asc はそのまま通る', () => {
    const parsed = boothListQuery.safeParse({ sort: 'name', order: 'asc' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({ sort: 'name', order: 'asc' })
    }
  })

  it('sort=id のような不正値は zod 不合格 → 呼び出し側で既定値にフォールバックする', () => {
    const parsed = boothListQuery.safeParse({ sort: 'id' })
    expect(parsed.success).toBe(false)
    const fallback = parsed.success ? parsed.data : { sort: 'checkin_count' as const, order: 'desc' as const }
    expect(fallback).toEqual({ sort: 'checkin_count', order: 'desc' })
  })

  it('SORT_SQL の3関数が期待どおりのSQL断片を返す', () => {
    expect(SORT_SQL.checkin_count(DIR_SQL.desc)).toBe('checkin_count DESC')
    expect(SORT_SQL.avg_rating(DIR_SQL.asc)).toBe('(avg_rating IS NULL), avg_rating ASC')
    expect(SORT_SQL.name(DIR_SQL.asc)).toBe('b.name ASC')
  })
})

describe('GET /api/v1/admin/events/:event_id/booths（#55）', () => {
  it('ソート未指定 → 200・ORDER BY に checkin_count DESC, b.name ASC が組み立てられる', async () => {
    const log: string[] = []
    const db = makeDb([{ match: /FROM booths b/, rows: boothRows }], log)
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/booths`,
      headers: managerAuth(),
    })
    expect(res.statusCode).toBe(200)
    expect(log[0]).toMatch(/ORDER BY checkin_count DESC, b\.name ASC/)
    await app.close()
  })

  it('?sort=avg_rating&order=asc → NULL は常に末尾になる式がSQLに含まれる', async () => {
    const log: string[] = []
    const db = makeDb([{ match: /FROM booths b/, rows: boothRows }], log)
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/booths?sort=avg_rating&order=asc`,
      headers: managerAuth(),
    })
    expect(res.statusCode).toBe(200)
    expect(log[0]).toMatch(/ORDER BY \(avg_rating IS NULL\), avg_rating ASC, b\.name ASC/)
    await app.close()
  })

  it('?sort=name&order=asc → 名前昇順のSQL断片', async () => {
    const log: string[] = []
    const db = makeDb([{ match: /FROM booths b/, rows: boothRows }], log)
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/booths?sort=name&order=asc`,
      headers: managerAuth(),
    })
    expect(res.statusCode).toBe(200)
    expect(log[0]).toMatch(/ORDER BY b\.name ASC, b\.name ASC/)
    await app.close()
  })

  it('不正な sort/order 値 → 200・既定ソートにフォールバック（SQLエラーにならない＝ホワイトリスト有効）', async () => {
    const log: string[] = []
    const db = makeDb([{ match: /FROM booths b/, rows: boothRows }], log)
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/booths?sort=DROP%20TABLE&order=x`,
      headers: managerAuth(),
    })
    expect(res.statusCode).toBe(200)
    expect(log[0]).toMatch(/ORDER BY checkin_count DESC, b\.name ASC/)
    await app.close()
  })

  it('avg_rating は評価0件なら null、あれば小数2桁丸め', async () => {
    const db = makeDb([{ match: /FROM booths b/, rows: boothRows }])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/booths`,
      headers: managerAuth(),
    })
    const body = res.json()
    expect(body.data.booths[0].avg_rating).toBe(4.26)
    expect(body.data.booths[1].avg_rating).toBeNull()
    await app.close()
  })

  it('checkin_count / comment_count は文字列で返っても Number()||0 で数値化される', async () => {
    const stringyRows = [
      { id: 'b-3', name: 'ブースC', checkin_count: '7', avg_rating: null, comment_count: '3' },
      { id: 'b-4', name: 'ブースD', checkin_count: null, avg_rating: null, comment_count: undefined },
    ]
    const db = makeDb([{ match: /FROM booths b/, rows: stringyRows }])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/booths`,
      headers: managerAuth(),
    })
    const body = res.json()
    expect(body.data.booths[0].checkin_count).toBe(7)
    expect(body.data.booths[0].comment_count).toBe(3)
    expect(body.data.booths[1].checkin_count).toBe(0)
    expect(body.data.booths[1].comment_count).toBe(0)
    await app.close()
  })

  it('comment_count のレスポンス封筒は data.booths に格納される', async () => {
    const db = makeDb([{ match: /FROM booths b/, rows: boothRows }])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/booths`,
      headers: managerAuth(),
    })
    const body = res.json()
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data.booths)).toBe(true)
    expect(body.data.booths).toHaveLength(2)
    await app.close()
  })
})

describe('GET /api/v1/admin/events/:event_id/booths の認可（requireStaff）', () => {
  it('viewer ロールの JWT → 200（GET は staff 可）', async () => {
    const db = makeDb([{ match: /FROM booths b/, rows: boothRows }])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/booths`,
      headers: viewerAuth(),
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('participant ロールの JWT → 403', async () => {
    const db = makeDb([{ match: /FROM booths b/, rows: boothRows }])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/booths`,
      headers: participantAuth(),
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('トークンなし → 401', async () => {
    const db = makeDb([{ match: /FROM booths b/, rows: boothRows }])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/booths`,
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('イベントIDが JWT と一致しない → 403', async () => {
    const db = makeDb([{ match: /FROM booths b/, rows: boothRows }])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/00000000-0000-4000-8000-000000000099/booths`,
      headers: managerAuth(),
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
