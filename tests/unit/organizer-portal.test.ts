import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { organizerEventRoutes } from '../../src/routes/v1/organizer/events.js'
import { organizerStaffRoutes } from '../../src/routes/v1/organizer/staff.js'
import { eventsPublicRoutes } from '../../src/routes/v1/events-public.js'
import { signOrganizerToken } from '../../src/lib/jwt.js'

const JWT_SECRET = 'test-secret'
const ORGANIZER_ID = 'org-1'

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

/** SQL 文字列をパターン照合して結果を返す DbClient モック。`log` に実行 SQL を記録する。 */
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
const writeHandlers: Handler[] = [
  { match: /^\s*INSERT|^\s*UPDATE|^\s*DELETE/i, rows: [] },
]

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(
    async (v1) => {
      await v1.register(organizerEventRoutes)
      await v1.register(organizerStaffRoutes)
      await v1.register(eventsPublicRoutes)
    },
    { prefix: '/api/v1' },
  )
  await app.ready()
  return app
}

const authHeader = () => ({
  authorization: `Bearer ${signOrganizerToken(JWT_SECRET, ORGANIZER_ID, '主催者')}`,
})

describe('GET /organizer/events（一覧）', () => {
  it('所有イベントのみ返り、3本の集計クエリを event ごとにマージする', async () => {
    const db = makeDb([
      {
        match: /FROM events\s+WHERE organizer_id = \?\s+ORDER BY date_start DESC/,
        rows: [
          { id: 'e1', name: 'Fes A', date_start: '2026-08-01 01:00:00', date_end: '2026-08-01 09:00:00', venue: '会場A', created_at: '2026-07-01 00:00:00' },
          { id: 'e2', name: 'Fes B', date_start: '2026-07-01 01:00:00', date_end: '2026-07-01 09:00:00', venue: null, created_at: '2026-06-01 00:00:00' },
        ],
      },
      { match: /FROM users\s+WHERE role = 'participant'/, rows: [{ event_id: 'e1', c: 40 }] },
      { match: /FROM booths/, rows: [{ event_id: 'e1', c: 18 }, { event_id: 'e2', c: 5 }] },
      { match: /FROM check_ins/, rows: [{ event_id: 'e1', c: 123 }] },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'GET', url: '/api/v1/organizer/events', headers: authHeader() })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.events).toHaveLength(2)
    expect(data.events[0]).toMatchObject({
      id: 'e1',
      date_start: '2026-08-01T01:00:00Z',
      stats: { participants: 40, booths: 18, checkins: 123 },
    })
    // 集計に現れないイベントは 0 で埋められる
    expect(data.events[1].stats).toEqual({ participants: 0, booths: 5, checkins: 0 })
    expect(data.events[0].urls.participant).toBe('https://front.example/join/e1')
    await app.close()
  })

  it('所有イベント 0 件のときは集計クエリを発行せず空配列を返す', async () => {
    const db = makeDb([
      { match: /FROM events\s+WHERE organizer_id = \?/, rows: [] },
      // stats クエリが呼ばれたら失敗する（呼ばれないことの検証）
      { match: /FROM (users|booths|check_ins)/, rows: () => { throw new Error('stats query should not run') } },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'GET', url: '/api/v1/organizer/events', headers: authHeader() })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ events: [] })
    await app.close()
  })
})

describe('PATCH /organizer/events/:id/staff/:uid（ロール変更）', () => {
  const ownership: Handler = { match: /FROM events WHERE id = \? AND organizer_id = \? LIMIT 1/, rows: [{ id: 'e1' }] }

  it('最後の manager を viewer にすると 409', async () => {
    const db = makeDb([
      ownership,
      { match: /FROM users WHERE id = \? AND event_id = \? AND role != 'participant' LIMIT 1/, rows: [{ id: 'u1', email: 'm@x.com', display_name: '管理', role: 'manager', created_at: '2026-07-01 00:00:00' }] },
      { match: /COUNT\(\*\) AS c FROM users\s+WHERE event_id = \? AND role IN \('manager','admin'\) AND id != \?/, rows: [{ c: 0 }] },
      ...writeHandlers,
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/organizer/events/e1/staff/u1', headers: authHeader(), payload: { role: 'viewer' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('CONFLICT')
    await app.close()
  })

  it('participant は対象にできず 404', async () => {
    const db = makeDb([
      ownership,
      { match: /FROM users WHERE id = \? AND event_id = \? AND role != 'participant' LIMIT 1/, rows: [] },
      ...writeHandlers,
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/organizer/events/e1/staff/p1', headers: authHeader(), payload: { role: 'viewer' } })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('他の manager が居れば viewer への変更が成功する', async () => {
    const db = makeDb([
      ownership,
      { match: /FROM users WHERE id = \? AND event_id = \? AND role != 'participant' LIMIT 1/, rows: [{ id: 'u1', email: 'm@x.com', display_name: '管理', role: 'manager', created_at: '2026-07-01 00:00:00' }] },
      { match: /COUNT\(\*\) AS c FROM users/, rows: [{ c: 1 }] },
      ...writeHandlers,
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/organizer/events/e1/staff/u1', headers: authHeader(), payload: { role: 'viewer' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.staff.role).toBe('viewer')
    await app.close()
  })

  it('同一ロールへの変更（manager → manager）は 200 で UPDATE・監査ログを行わない（冪等）', async () => {
    const log: string[] = []
    const db = makeDb([
      ownership,
      { match: /FROM users WHERE id = \? AND event_id = \? AND role != 'participant' LIMIT 1/, rows: [{ id: 'u1', email: 'm@x.com', display_name: '管理', role: 'manager', created_at: '2026-07-01 00:00:00' }] },
      ...writeHandlers,
    ], log)
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/organizer/events/e1/staff/u1', headers: authHeader(), payload: { role: 'manager' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.staff.role).toBe('manager')
    expect(log.some((sql) => /UPDATE users/.test(sql))).toBe(false)
    expect(log.some((sql) => /INSERT INTO audit_logs/.test(sql))).toBe(false)
    await app.close()
  })

  it('viewer → viewer の no-op は最後の manager ガードより先に 200 を返す', async () => {
    const log: string[] = []
    const db = makeDb([
      ownership,
      { match: /FROM users WHERE id = \? AND event_id = \? AND role != 'participant' LIMIT 1/, rows: [{ id: 'v1', email: 'v@x.com', display_name: '閲覧', role: 'viewer', created_at: '2026-07-02 00:00:00' }] },
      // COUNT が呼ばれたら 0（誤って呼ばれた場合 409 になり検出できる）
      { match: /COUNT\(\*\) AS c FROM users/, rows: [{ c: 0 }] },
      ...writeHandlers,
    ], log)
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/organizer/events/e1/staff/v1', headers: authHeader(), payload: { role: 'viewer' } })
    expect(res.statusCode).toBe(200)
    expect(log.some((sql) => /UPDATE users|INSERT INTO audit_logs/.test(sql))).toBe(false)
    await app.close()
  })

  it('旧 admin への manager 指定は表記の正規化 UPDATE のみ行い監査ログは記録しない', async () => {
    const log: string[] = []
    const db = makeDb([
      ownership,
      { match: /FROM users WHERE id = \? AND event_id = \? AND role != 'participant' LIMIT 1/, rows: [{ id: 'a1', email: 'a@x.com', display_name: '旧管理', role: 'admin', created_at: '2026-07-01 00:00:00' }] },
      ...writeHandlers,
    ], log)
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/organizer/events/e1/staff/a1', headers: authHeader(), payload: { role: 'manager' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.staff.role).toBe('manager')
    expect(log.some((sql) => /UPDATE users/.test(sql))).toBe(true)
    expect(log.some((sql) => /INSERT INTO audit_logs/.test(sql))).toBe(false)
    await app.close()
  })
})

describe('DELETE /organizer/events/:id/staff/:uid（削除）', () => {
  const ownership: Handler = { match: /FROM events WHERE id = \? AND organizer_id = \? LIMIT 1/, rows: [{ id: 'e1' }] }

  it('最後の manager は削除できず 409', async () => {
    const db = makeDb([
      ownership,
      { match: /FROM users WHERE id = \? AND event_id = \? AND role != 'participant' LIMIT 1/, rows: [{ id: 'u1', email: 'm@x.com', display_name: '管理', role: 'manager', created_at: '2026-07-01 00:00:00' }] },
      { match: /COUNT\(\*\) AS c FROM users/, rows: [{ c: 0 }] },
      ...writeHandlers,
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/organizer/events/e1/staff/u1', headers: authHeader() })
    expect(res.statusCode).toBe(409)
    await app.close()
  })

  it('viewer は manager 数に影響しないので削除できる', async () => {
    const db = makeDb([
      ownership,
      { match: /FROM users WHERE id = \? AND event_id = \? AND role != 'participant' LIMIT 1/, rows: [{ id: 'v1', email: 'v@x.com', display_name: '閲覧', role: 'viewer', created_at: '2026-07-02 00:00:00' }] },
      ...writeHandlers,
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/organizer/events/e1/staff/v1', headers: authHeader() })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ deleted: true })
    await app.close()
  })
})

describe('GET /events/:id/public（公開イベント情報）', () => {
  it('5 フィールドのみ返す', async () => {
    const db = makeDb([
      { match: /FROM events WHERE id = \? LIMIT 1/, rows: [{ id: 'e1', name: 'Fes A', date_start: '2026-08-01 01:00:00', date_end: '2026-08-01 09:00:00', venue: '会場A' }] },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'GET', url: '/api/v1/events/e1/public' })
    expect(res.statusCode).toBe(200)
    expect(Object.keys(res.json().data.event).sort()).toEqual(['date_end', 'date_start', 'id', 'name', 'venue'])
    await app.close()
  })

  it('存在しない ID は 404', async () => {
    const db = makeDb([{ match: /FROM events WHERE id = \? LIMIT 1/, rows: [] }])
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'GET', url: '/api/v1/events/nope/public' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
