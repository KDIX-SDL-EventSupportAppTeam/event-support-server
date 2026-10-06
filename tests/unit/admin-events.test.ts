import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { adminEventRoutes } from '../../src/routes/v1/admin/events.js'

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

const managerAuth = () => ({
  authorization: `Bearer ${jwt.sign(
    { sub: 'mgr-1', event_id: EVENT_ID, display_name: '', role: 'manager' },
    JWT_SECRET,
    { algorithm: 'HS256' },
  )}`,
})

describe('PATCH /admin/events/:event_id（issue #156）', () => {
  it('survey_url を更新でき、監査ログに before / after を残す', async () => {
    const audit: unknown[][] = []
    let updated = false
    const row = (url: string | null) => ({
      id: EVENT_ID,
      name: 'イベント',
      date_start: '2026-10-01 01:00:00',
      date_end: '2026-10-01 09:00:00',
      venue: null,
      survey_url: url,
      created_at: '2026-09-01 00:00:00',
    })
    const run = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
      if (/^\s*UPDATE events/.test(sql)) {
        updated = true
        return [{ affectedRows: 1 }, undefined]
      }
      if (/INSERT INTO audit_logs/.test(sql)) {
        audit.push(params)
        return [{ affectedRows: 1 }, undefined]
      }
      if (/FROM events WHERE id = \? LIMIT 1/.test(sql)) {
        return [[row(updated ? 'https://forms.gle/new' : 'https://forms.gle/old')], undefined]
      }
      throw new Error(`unmatched SQL: ${sql}`)
    }
    const db = { query: run, execute: run, end: async () => {} } as DbClient
    const app = Fastify()
    app.decorate('config', config)
    app.decorate('db', db)
    await app.register(async (v1) => v1.register(adminEventRoutes), { prefix: '/api/v1' })
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/events/${EVENT_ID}`,
      headers: managerAuth(),
      payload: { survey_url: 'https://forms.gle/new' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.event.survey_url).toBe('https://forms.gle/new')

    expect(audit).toHaveLength(1)
    const detail = JSON.parse(String(audit[0].find((p) => typeof p === 'string' && p.includes('before'))))
    expect(detail.before.survey_url).toBe('https://forms.gle/old')
    expect(detail.after.survey_url).toBe('https://forms.gle/new')
    await app.close()
  })
})
