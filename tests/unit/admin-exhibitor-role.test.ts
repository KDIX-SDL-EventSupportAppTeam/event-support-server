import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { adminExhibitorRoutes, groupExhibitorsByBooth } from '../../src/routes/v1/admin/exhibitors.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '20000000-0000-4000-8000-000000000001'
const USER_ID = '30000000-0000-4000-8000-000000000001'
const BOOTH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BOOTH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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

type Handler = { match: RegExp; rows: unknown | ((params: unknown[]) => unknown) }
type Call = { sql: string; params: unknown[] }

/** SQL 文字列をパターン照合して結果を返す DbClient モック（exhibitor.test.ts と同じ流儀）。 */
function makeDb(handlers: Handler[], log: Call[] = []): DbClient {
  const run = async (sql: string, params: unknown[] = []) => {
    log.push({ sql, params })
    const h = handlers.find((x) => x.match.test(sql))
    if (!h) throw new Error(`unmatched SQL: ${sql}`)
    const rows = typeof h.rows === 'function' ? (h.rows as (p: unknown[]) => unknown)(params) : h.rows
    return [rows, undefined] as [unknown, unknown]
  }
  return { query: run, execute: run, end: async () => {} }
}

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(async (v1) => v1.register(adminExhibitorRoutes), { prefix: '/api/v1' })
  await app.ready()
  return app
}

function auth(role: string, eventId = EVENT_ID) {
  const token = jwt.sign({ sub: `${role}-1`, event_id: eventId, display_name: '', role }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
  })
  return { authorization: `Bearer ${token}` }
}

const row = (o: Partial<Parameters<typeof groupExhibitorsByBooth>[0][number]>) => ({
  user_id: 'u',
  email: 'u@example.com',
  display_name: null,
  created_at: '2026-10-01 00:00:00',
  booth_id: null,
  booth_name: null,
  display_code: null,
  ...o,
})

describe('groupExhibitorsByBooth', () => {
  it('ブース番号の自然順・null は末尾でブース名順・出展者はメール昇順・未紐付けは unassigned', () => {
    const result = groupExhibitorsByBooth([
      row({ user_id: 'u1', email: 'b@x', booth_id: 'b10', booth_name: 'ゼミ10', display_code: '10' }),
      row({ user_id: 'u2', email: 'a@x', booth_id: 'b10', booth_name: 'ゼミ10', display_code: '10' }),
      row({ user_id: 'u1', email: 'b@x', booth_id: 'b2', booth_name: 'ゼミ2', display_code: '2' }),
      row({ user_id: 'u3', email: 'c@x', booth_id: 'bnY', booth_name: 'Y', display_code: null }),
      row({ user_id: 'u4', email: 'd@x', booth_id: 'bnX', booth_name: 'X', display_code: null }),
      row({ user_id: 'u6', email: 'z@x' }),
      row({ user_id: 'u5', email: 'e@x' }),
    ])
    expect(result.booths.map((b) => b.booth_id)).toEqual(['b2', 'b10', 'bnX', 'bnY'])
    expect(result.booths[1].exhibitors.map((e) => e.email)).toEqual(['a@x', 'b@x'])
    // 複数ブース担当はそれぞれに出る
    expect(result.booths[0].exhibitors[0].user_id).toBe('u1')
    expect(result.unassigned.map((e) => e.email)).toEqual(['e@x', 'z@x'])
    expect(result.unassigned[0].created_at).toBe('2026-10-01T00:00:00Z')
  })
})

describe('GET /admin/events/:event_id/exhibitors', () => {
  const listHandlers: Handler[] = [
    { match: /FROM users u\s+LEFT JOIN exhibitor_booths/, rows: [row({ user_id: 'u1', email: 'a@x', booth_id: BOOTH_A, booth_name: 'A', display_code: '1' })] },
    {
      match: /FROM exhibitor_invites i/,
      rows: [{ email: 'inv@x', booth_id: BOOTH_A, booth_name: 'A', display_code: '1', created_at: '2026-10-01 00:00:00' }],
    },
  ]

  it('viewer は閲覧できる', async () => {
    const app = await buildTestApp(makeDb(listHandlers))
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/exhibitors`, headers: auth('viewer') })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.booths[0].exhibitors[0].email).toBe('a@x')
    expect(res.json().data.unassigned).toEqual([])
    expect(res.json().data.invites).toEqual([
      { email: 'inv@x', booth_id: BOOTH_A, booth_name: 'A', display_code: '1', created_at: '2026-10-01T00:00:00Z' },
    ])
    await app.close()
  })

  it('participant / exhibitor は 403、他イベントの JWT も 403', async () => {
    const app = await buildTestApp(makeDb(listHandlers))
    for (const headers of [auth('participant'), auth('exhibitor'), auth('manager', 'other-event')]) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/exhibitors`, headers })
      expect(res.statusCode).toBe(403)
    }
    await app.close()
  })
})

describe('PATCH /admin/events/:event_id/users/:user_id/role', () => {
  const url = `/api/v1/admin/events/${EVENT_ID}/users/${USER_ID}/role`

  function handlers(opts: {
    role?: string | null
    booths?: string[]
    linked?: string[]
    affected?: number
  }): Handler[] {
    return [
      {
        match: /SELECT id, email, role FROM users/,
        rows: opts.role === undefined ? [] : [{ id: USER_ID, email: 't@example.com', role: opts.role }],
      },
      { match: /SELECT id FROM booths/, rows: (opts.booths ?? []).map((id) => ({ id })) },
      { match: /SELECT booth_id FROM exhibitor_booths/, rows: (opts.linked ?? []).map((booth_id) => ({ booth_id })) },
      { match: /^\s*UPDATE users/, rows: { affectedRows: opts.affected ?? 1 } },
      { match: /^\s*(INSERT|DELETE)/, rows: { affectedRows: 1 } },
    ]
  }

  it('viewer / participant は 403', async () => {
    const app = await buildTestApp(makeDb(handlers({ role: 'participant' })))
    for (const headers of [auth('viewer'), auth('participant')]) {
      const res = await app.inject({ method: 'PATCH', url, headers, payload: { role: 'participant' } })
      expect(res.statusCode).toBe(403)
    }
    await app.close()
  })

  it('booth_ids が空なら 422', async () => {
    const app = await buildTestApp(makeDb(handlers({ role: 'participant' })))
    const res = await app.inject({ method: 'PATCH', url, headers: auth('manager'), payload: { role: 'exhibitor', booth_ids: [] } })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('対象ユーザーがイベントにいなければ 404', async () => {
    const app = await buildTestApp(makeDb(handlers({})))
    const res = await app.inject({ method: 'PATCH', url, headers: auth('manager'), payload: { role: 'participant' } })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('participant → exhibitor: ロール更新・紐付け作成・監査ログ。重複 booth_id は1件に畳む', async () => {
    const log: Call[] = []
    const app = await buildTestApp(makeDb(handlers({ role: 'participant', booths: [BOOTH_A, BOOTH_B] }), log))
    const res = await app.inject({
      method: 'PATCH', url, headers: auth('manager'),
      payload: { role: 'exhibitor', booth_ids: [BOOTH_A, BOOTH_B, BOOTH_A] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ user_id: USER_ID, role: 'exhibitor' })
    expect(log.some((c) => /UPDATE users SET role = 'exhibitor' WHERE id = \? AND role = 'participant'/.test(c.sql))).toBe(true)
    const inserts = log.filter((c) => /INSERT INTO exhibitor_booths/.test(c.sql))
    expect(inserts.map((c) => c.params[1])).toEqual([BOOTH_A, BOOTH_B])
    expect(log.some((c) => /password_hash/.test(c.sql))).toBe(false)
    const audit = log.find((c) => /INSERT INTO audit_logs/.test(c.sql))!
    expect(audit.params).toContain('user.role_change')
    expect(JSON.parse(audit.params[7] as string)).toEqual({
      email: 't@example.com', from: 'participant', to: 'exhibitor', booth_ids: [BOOTH_A, BOOTH_B],
    })
    await app.close()
  })

  it('participant → exhibitor: 既に紐付いているブースはスキップ（冪等）', async () => {
    const log: Call[] = []
    const app = await buildTestApp(makeDb(handlers({ role: 'participant', booths: [BOOTH_A, BOOTH_B], linked: [BOOTH_A] }), log))
    const res = await app.inject({ method: 'PATCH', url, headers: auth('manager'), payload: { role: 'exhibitor', booth_ids: [BOOTH_A, BOOTH_B] } })
    expect(res.statusCode).toBe(200)
    expect(log.filter((c) => /INSERT INTO exhibitor_booths/.test(c.sql)).map((c) => c.params[1])).toEqual([BOOTH_B])
    await app.close()
  })

  it('他イベント・存在しないブースを含めば 404 で何も書き込まない', async () => {
    const log: Call[] = []
    const app = await buildTestApp(makeDb(handlers({ role: 'participant', booths: [BOOTH_A] }), log))
    const res = await app.inject({ method: 'PATCH', url, headers: auth('manager'), payload: { role: 'exhibitor', booth_ids: [BOOTH_A, BOOTH_B] } })
    expect(res.statusCode).toBe(404)
    expect(log.some((c) => /^\s*(UPDATE|INSERT|DELETE)/.test(c.sql))).toBe(false)
    await app.close()
  })

  it('exhibitor → participant: ロール更新・email_verified_at 補完・紐付け全削除', async () => {
    const log: Call[] = []
    const app = await buildTestApp(makeDb(handlers({ role: 'exhibitor' }), log))
    const res = await app.inject({ method: 'PATCH', url, headers: auth('manager'), payload: { role: 'participant' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ user_id: USER_ID, role: 'participant' })
    const update = log.find((c) => /^\s*UPDATE users/.test(c.sql))!
    expect(update.sql).toMatch(/email_verified_at = COALESCE\(email_verified_at, \?\).*AND role = 'exhibitor'/)
    expect(log.some((c) => /DELETE FROM exhibitor_booths WHERE user_id = \?/.test(c.sql))).toBe(true)
    await app.close()
  })

  it('ロールが想定と違えば 409（既に exhibitor を exhibitor に／participant を participant に）', async () => {
    let app = await buildTestApp(makeDb(handlers({ role: 'exhibitor', booths: [BOOTH_A] })))
    let res = await app.inject({ method: 'PATCH', url, headers: auth('manager'), payload: { role: 'exhibitor', booth_ids: [BOOTH_A] } })
    expect(res.statusCode).toBe(409)
    await app.close()
    app = await buildTestApp(makeDb(handlers({ role: 'participant' })))
    res = await app.inject({ method: 'PATCH', url, headers: auth('manager'), payload: { role: 'participant' } })
    expect(res.statusCode).toBe(409)
    await app.close()
  })

  it.each(['manager', 'viewer', 'admin'])('運営アカウント（%s）は 409 で変更できない', async (role) => {
    const log: Call[] = []
    const app = await buildTestApp(makeDb(handlers({ role }), log))
    const res = await app.inject({ method: 'PATCH', url, headers: auth('manager'), payload: { role: 'participant' } })
    expect(res.statusCode).toBe(409)
    expect(log.some((c) => /^\s*UPDATE/.test(c.sql))).toBe(false)
    await app.close()
  })

  it('条件付き UPDATE が 0 件（同時更新）なら 409 で紐付けを作らない', async () => {
    const log: Call[] = []
    const app = await buildTestApp(makeDb(handlers({ role: 'participant', booths: [BOOTH_A], affected: 0 }), log))
    const res = await app.inject({ method: 'PATCH', url, headers: auth('manager'), payload: { role: 'exhibitor', booth_ids: [BOOTH_A] } })
    expect(res.statusCode).toBe(409)
    expect(log.some((c) => /INSERT INTO exhibitor_booths/.test(c.sql))).toBe(false)
    await app.close()
  })
})
