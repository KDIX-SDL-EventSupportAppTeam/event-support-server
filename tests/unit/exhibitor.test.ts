import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { adminExhibitorRoutes } from '../../src/routes/v1/admin/exhibitors.js'
import { exhibitorRoutes } from '../../src/routes/v1/exhibitor.js'
import { verifyAccessToken } from '../../src/lib/jwt.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '20000000-0000-4000-8000-000000000001'
const BOOTH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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

/** SQL 文字列をパターン照合して結果を返す DbClient モック（F14: organizer-portal.test.ts と同じ流儀）。 */
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

/** 書き込み（INSERT/UPDATE/DELETE）を素通しする共通ハンドラ。 */
const writeHandlers: Handler[] = [{ match: /^\s*INSERT|^\s*UPDATE|^\s*DELETE/i, rows: [] }]

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(
    async (v1) => {
      await v1.register(adminExhibitorRoutes)
      await v1.register(exhibitorRoutes)
    },
    { prefix: '/api/v1' },
  )
  await app.ready()
  return app
}

/** 参加者/運営/出展者 JWT を直接組み立てる（signAccessToken は date_end の DB 参照を要するため使わない）。 */
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
const participantAuth = (sub = 'p-1') => ({
  authorization: `Bearer ${signToken({ sub, event_id: EVENT_ID, role: 'participant' })}`,
})
const exhibitorAuth = (sub = 'ex-1') => ({
  authorization: `Bearer ${signToken({ sub, event_id: EVENT_ID, role: 'exhibitor' })}`,
})

describe('POST /admin/events/:event_id/exhibitors/bulk', () => {
  it('非 manager トークンは 403', async () => {
    const db = makeDb([])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/exhibitors/bulk`,
      headers: participantAuth(),
      payload: { accounts: [{ email: 'a@example.com', password: 'password1', booth_id: BOOTH_ID }] },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('zod 不正（email 形式）は 422', async () => {
    const db = makeDb([])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/exhibitors/bulk`,
      headers: managerAuth(),
      payload: { accounts: [{ email: 'not-an-email', password: 'password1', booth_id: BOOTH_ID }] },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('zod 不正（password 7文字）は 422', async () => {
    const db = makeDb([])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/exhibitors/bulk`,
      headers: managerAuth(),
      payload: { accounts: [{ email: 'a@example.com', password: '1234567', booth_id: BOOTH_ID }] },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('zod 不正（accounts 空配列）は 422', async () => {
    const db = makeDb([])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/exhibitors/bulk`,
      headers: managerAuth(),
      payload: { accounts: [] },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('新規=INSERT users+INSERT exhibitor_booths、既存participant=UPDATE role+INSERT、既存manager=行エラーCONFLICT', async () => {
    const log: string[] = []
    const db = makeDb(
      [
        { match: /SELECT id, name FROM booths WHERE event_id = \?/, rows: [{ id: BOOTH_ID, name: 'ブースA' }] },
        {
          match: /SELECT id, role FROM users WHERE event_id = \? AND email = \? LIMIT 1/,
          rows: (params) => {
            const email = params[1] as string
            if (email === 'new@example.com') return []
            if (email === 'exist-participant@example.com') {
              return [{ id: 'p-exist', role: 'participant' }]
            }
            if (email === 'mgr@example.com') return [{ id: 'm-exist', role: 'manager' }]
            return []
          },
        },
        ...writeHandlers,
      ],
      log,
    )
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/exhibitors/bulk`,
      headers: managerAuth(),
      payload: {
        accounts: [
          { email: 'new@example.com', password: 'password1', booth_id: BOOTH_ID },
          { email: 'exist-participant@example.com', password: 'password1', booth_id: BOOTH_ID },
          { email: 'mgr@example.com', password: 'password1', booth_id: BOOTH_ID },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.summary).toEqual({ total: 3, created: 1, updated: 1, skipped: 0, failed: 1 })
    expect(data.results[0].status).toBe('created')
    expect(data.results[1].status).toBe('updated')
    expect(data.results[2]).toMatchObject({ status: 'error', error: { code: 'CONFLICT' } })
    expect(log.some((sql) => /INSERT INTO users/.test(sql))).toBe(true)
    expect(log.some((sql) => /INSERT INTO exhibitor_booths/.test(sql))).toBe(true)
    expect(log.some((sql) => /UPDATE users SET role = 'exhibitor'/.test(sql))).toBe(true)
    expect(log.some((sql) => /INSERT INTO audit_logs/.test(sql))).toBe(true)
    await app.close()
  })

  it('既存 exhibitor + 同じブースは skipped（冪等）、既存 exhibitor + 新しいブースは updated', async () => {
    const OTHER_BOOTH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const log: string[] = []
    const db = makeDb(
      [
        {
          match: /SELECT id, name FROM booths WHERE event_id = \?/,
          rows: [
            { id: BOOTH_ID, name: 'ブースA' },
            { id: OTHER_BOOTH, name: 'ブースB' },
          ],
        },
        {
          match: /SELECT id, role FROM users WHERE event_id = \? AND email = \? LIMIT 1/,
          rows: [{ id: 'ex-exist', role: 'exhibitor' }],
        },
        {
          match: /SELECT 1 FROM exhibitor_booths WHERE user_id = \? AND booth_id = \?/,
          rows: (params) => (params[1] === BOOTH_ID ? [{ 1: 1 }] : []),
        },
        ...writeHandlers,
      ],
      log,
    )
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/exhibitors/bulk`,
      headers: managerAuth(),
      payload: {
        accounts: [
          { email: 'ex@example.com', password: 'password1', booth_id: BOOTH_ID },
          { email: 'ex@example.com', password: 'password1', booth_id: OTHER_BOOTH },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.summary).toEqual({ total: 2, created: 0, updated: 1, skipped: 1, failed: 0 })
    expect(data.results[0].status).toBe('skipped')
    expect(data.results[1].status).toBe('updated')
    await app.close()
  })

  it('booth_id がイベントに存在しないと行エラー NOT_FOUND', async () => {
    const db = makeDb([
      { match: /SELECT id, name FROM booths WHERE event_id = \?/, rows: [] },
      ...writeHandlers,
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/exhibitors/bulk`,
      headers: managerAuth(),
      payload: { accounts: [{ email: 'a@example.com', password: 'password1', booth_id: BOOTH_ID }] },
    })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.results[0]).toMatchObject({ status: 'error', error: { code: 'NOT_FOUND' } })
    await app.close()
  })

  it('リクエスト内で (email, booth_id) が重複する行は2件目以降を VALIDATION_ERROR にする', async () => {
    const db = makeDb([
      { match: /SELECT id, name FROM booths WHERE event_id = \?/, rows: [{ id: BOOTH_ID, name: 'ブースA' }] },
      { match: /SELECT id, role FROM users WHERE event_id = \? AND email = \? LIMIT 1/, rows: [] },
      ...writeHandlers,
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/exhibitors/bulk`,
      headers: managerAuth(),
      payload: {
        accounts: [
          { email: 'dup@example.com', password: 'password1', booth_id: BOOTH_ID },
          { email: 'DUP@example.com', password: 'password1', booth_id: BOOTH_ID },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.results[0].status).toBe('created')
    expect(data.results[1]).toMatchObject({ status: 'error', error: { code: 'VALIDATION_ERROR' } })
    await app.close()
  })
})

describe('GET /events/:event_id/exhibitor/booths/:booth_id/stats', () => {
  it('exhibitor_booths に行が無い（担当外ブース）は 403', async () => {
    const db = makeDb([{ match: /FROM exhibitor_booths eb/, rows: [] }])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${EVENT_ID}/exhibitor/booths/${BOOTH_ID}/stats`,
      headers: exhibitorAuth(),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
    await app.close()
  })

  it('認可クエリは userId・boothId・eventId の3つをバインドする（他イベントの booth 漏洩防止）', async () => {
    const seenParams: unknown[][] = []
    const db = makeDb([
      {
        match: /FROM exhibitor_booths eb/,
        rows: (params) => {
          seenParams.push(params)
          return []
        },
      },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${EVENT_ID}/exhibitor/booths/${BOOTH_ID}/stats`,
      headers: exhibitorAuth('ex-42'),
    })
    expect(res.statusCode).toBe(403)
    expect(seenParams[0]).toEqual(['ex-42', BOOTH_ID, EVENT_ID])
    await app.close()
  })

  it('正常系: hourly_checkins の並び順を保持し、avg_rating を2桁に丸め、is_hidden=0の条件をSQLに含める', async () => {
    const log: string[] = []
    const db = makeDb(
      [
        { match: /FROM exhibitor_booths eb/, rows: [{ id: BOOTH_ID, name: 'ブースA' }] },
        { match: /SELECT COUNT\(\*\) AS c FROM check_ins/, rows: [{ c: 42 }] },
        {
          match: /SELECT DATE_FORMAT\(checked_in_at, '%H:00'\)/,
          rows: [
            { time_slot: '10:00', count: 5 },
            { time_slot: '11:00', count: 12 },
          ],
        },
        {
          match: /SELECT rating, COUNT\(\*\) AS cnt FROM booth_ratings/,
          rows: [
            { rating: 5, cnt: 2 },
            { rating: 4, cnt: 1 },
          ],
        },
        {
          match: /SELECT id, rating, comment, rated_at FROM booth_ratings/,
          rows: [
            { id: 'c1', rating: 5, comment: '説明が分かりやすかった', rated_at: '2026-10-25 01:23:45' },
          ],
        },
      ],
      log,
    )
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${EVENT_ID}/exhibitor/booths/${BOOTH_ID}/stats`,
      headers: exhibitorAuth(),
    })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.booth).toEqual({ id: BOOTH_ID, name: 'ブースA' })
    expect(data.total_checkins).toBe(42)
    // 並び順はDBのORDER BYに従う。ハンドラ側で並び替えず素通しすることを確認する
    expect(data.hourly_checkins).toEqual([
      { time_slot: '10:00', count: 5 },
      { time_slot: '11:00', count: 12 },
    ])
    // (5*2 + 4*1) / 3 = 4.666... -> 4.67 に丸める
    expect(data.ratings.avg_rating).toBe(4.67)
    expect(data.ratings.count).toBe(3)
    expect(data.ratings.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 2 })
    expect(data.comments).toEqual([
      { id: 'c1', rating: 5, comment: '説明が分かりやすかった', rated_at: '2026-10-25T01:23:45Z' },
    ])
    expect(log.some((sql) => /is_hidden = 0/.test(sql))).toBe(true)
    expect(log.some((sql) => /comment <> ''/.test(sql))).toBe(true)
    await app.close()
  })
})

describe('GET /events/:event_id/exhibitor/booths', () => {
  it('participant ロールは {is_exhibitor:false, booths:[]} を返し booths クエリを発行しない', async () => {
    const db = makeDb([
      { match: /SELECT role FROM users WHERE id = \? AND event_id = \? LIMIT 1/, rows: [{ role: 'participant' }] },
      {
        match: /FROM exhibitor_booths eb\s+JOIN booths b/,
        rows: () => {
          throw new Error('booths query should not run')
        },
      },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${EVENT_ID}/exhibitor/booths`,
      headers: participantAuth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ is_exhibitor: false, booths: [] })
    await app.close()
  })

  it('exhibitor ロールは is_exhibitor:true と担当ブース一覧を返す', async () => {
    const db = makeDb([
      { match: /SELECT role FROM users WHERE id = \? AND event_id = \? LIMIT 1/, rows: [{ role: 'exhibitor' }] },
      { match: /FROM exhibitor_booths eb\s+JOIN booths b/, rows: [{ id: BOOTH_ID, name: 'ブースA' }] },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${EVENT_ID}/exhibitor/booths`,
      headers: exhibitorAuth(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({
      is_exhibitor: true,
      booths: [{ id: BOOTH_ID, name: 'ブースA' }],
    })
    await app.close()
  })
})

describe('verifyAccessToken', () => {
  it("role='exhibitor' を丸めずに返す", () => {
    const token = jwt.sign(
      { sub: 'u1', event_id: EVENT_ID, display_name: 'x', role: 'exhibitor' },
      JWT_SECRET,
      { algorithm: 'HS256' },
    )
    const decoded = verifyAccessToken(JWT_SECRET, token)
    expect(decoded.role).toBe('exhibitor')
  })

  it("未知の role は従来通り 'participant' に丸める", () => {
    const token = jwt.sign(
      { sub: 'u1', event_id: EVENT_ID, display_name: 'x', role: 'unknown-role' },
      JWT_SECRET,
      { algorithm: 'HS256' },
    )
    const decoded = verifyAccessToken(JWT_SECRET, token)
    expect(decoded.role).toBe('participant')
  })
})
