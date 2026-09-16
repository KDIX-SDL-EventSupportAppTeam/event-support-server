import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import type { JwtPayload } from '../../src/lib/jwt.js'
import { adminAuditLogRoutes } from '../../src/routes/v1/admin/audit-logs.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = 'e1'

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

function signStaffToken(role: JwtPayload['role'], eventId: string = EVENT_ID, sub = 'staff-1'): string {
  const payload: JwtPayload = { sub, event_id: eventId, display_name: 'スタッフ', role }
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
}

const authHeader = (role: JwtPayload['role'], eventId?: string) => ({
  authorization: `Bearer ${signStaffToken(role, eventId)}`,
})

type Call = { sql: string; params: unknown[] }

type AuditLogRowFixture = {
  id: string
  event_id: string
  actor_id: string
  actor_role: string
  action: string
  target_type: string
  target_id: string | null
  detail: string | unknown
  created_at: string
  actor_display_name: string | null
  actor_email: string | null
}

const sampleRow: AuditLogRowFixture = {
  id: 'log-1',
  event_id: EVENT_ID,
  actor_id: 'staff-1',
  actor_role: 'manager',
  action: 'booth.update',
  target_type: 'booth',
  target_id: 'booth-1',
  detail: JSON.stringify({ before: 1, after: 2 }),
  created_at: '2026-07-01 12:00:00',
  actor_display_name: '管理太郎',
  actor_email: 'manager@example.com',
}

/** 監査ログ一覧 API 用の DbClient モック。呼び出し SQL/params を calls に記録する。 */
function makeDb(
  calls: Call[],
  opts: { total?: number; list?: AuditLogRowFixture[] } = {},
): DbClient {
  const total = opts.total ?? 1
  const list = opts.list ?? [sampleRow]
  const run = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (/COUNT\(\*\) AS total/.test(sql)) {
      return [[{ total }], undefined] as [unknown, unknown]
    }
    if (/FROM audit_logs al/.test(sql)) {
      return [list, undefined] as [unknown, unknown]
    }
    throw new Error(`unmatched SQL: ${sql}`)
  }
  return { query: run, execute: run, end: async () => {} }
}

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(
    async (v1) => {
      await v1.register(adminAuditLogRoutes)
    },
    { prefix: '/api/v1' },
  )
  await app.ready()
  return app
}

function listCall(calls: Call[]): Call {
  const call = calls.find((c) => /FROM audit_logs al/.test(c.sql))
  if (!call) throw new Error('list query was not called')
  return call
}

describe('GET /admin/events/:event_id/audit-logs（一覧）', () => {
  it('LIMIT/OFFSET を直埋めし、プレースホルダは event_id の1件だけになる（既定 page=1/limit=50）', async () => {
    const calls: Call[] = []
    const db = makeDb(calls)
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/audit-logs`,
      headers: authHeader('manager'),
    })
    expect(res.statusCode).toBe(200)
    const { sql, params } = listCall(calls)
    expect(sql).toContain('LIMIT 50 OFFSET 0')
    expect(sql).not.toContain('LIMIT ?')
    expect(params).toEqual([EVENT_ID])
    await app.close()
  })

  it('page=3&limit=20 で LIMIT 20 OFFSET 40 になる', async () => {
    const calls: Call[] = []
    const db = makeDb(calls)
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/audit-logs?page=3&limit=20`,
      headers: authHeader('manager'),
    })
    expect(res.statusCode).toBe(200)
    const { sql, params } = listCall(calls)
    expect(sql).toContain('LIMIT 20 OFFSET 40')
    expect(params).toEqual([EVENT_ID])
    await app.close()
  })

  it('page=abc&limit=-5 のような不正な query は 500 にならず既定 LIMIT 50 OFFSET 0 で 200 になる', async () => {
    const calls: Call[] = []
    const db = makeDb(calls)
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/audit-logs?page=abc&limit=-5`,
      headers: authHeader('manager'),
    })
    expect(res.statusCode).toBe(200)
    const { sql } = listCall(calls)
    expect(sql).toContain('LIMIT 50 OFFSET 0')
    await app.close()
  })

  it('detail の JSON 文字列を object に、壊れた JSON は null に変換する', async () => {
    const calls: Call[] = []
    const db = makeDb(calls, {
      list: [
        { ...sampleRow, id: 'log-1', detail: JSON.stringify({ a: 1 }) },
        { ...sampleRow, id: 'log-2', detail: '{invalid json' },
      ],
    })
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/audit-logs`,
      headers: authHeader('manager'),
    })
    expect(res.statusCode).toBe(200)
    const logs = res.json().data.audit_logs
    expect(logs[0].detail).toEqual({ a: 1 })
    expect(logs[1].detail).toBeNull()
    await app.close()
  })

  it('created_at が ISO 8601（...T...Z）形式になり、actor_display_name/actor_email は null を許容する', async () => {
    const calls: Call[] = []
    const db = makeDb(calls, {
      list: [
        { ...sampleRow, created_at: '2026-07-01 12:00:00', actor_display_name: null, actor_email: null },
      ],
    })
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/audit-logs`,
      headers: authHeader('manager'),
    })
    expect(res.statusCode).toBe(200)
    const log = res.json().data.audit_logs[0]
    expect(log.created_at).toBe('2026-07-01T12:00:00Z')
    expect(log.actor_display_name).toBeNull()
    expect(log.actor_email).toBeNull()
    await app.close()
  })

  it('JWT なしは 401', async () => {
    const calls: Call[] = []
    const db = makeDb(calls)
    const app = await buildTestApp(db)
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/audit-logs` })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('participant ロールは 403', async () => {
    const calls: Call[] = []
    const db = makeDb(calls)
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/audit-logs`,
      headers: authHeader('participant'),
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('JWT の event_id と一致しない event_id は 403', async () => {
    const calls: Call[] = []
    const db = makeDb(calls)
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/other-event/audit-logs`,
      headers: authHeader('manager', EVENT_ID),
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
