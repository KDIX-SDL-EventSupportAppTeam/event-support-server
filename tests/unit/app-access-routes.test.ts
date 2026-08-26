import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import Fastify, { type FastifyInstance } from 'fastify'
import type { DbClient } from '../../src/db/client.js'
import { appAccessRoutes } from '../../src/routes/v1/app-access.js'
import { organizerAppAccessRoutes } from '../../src/routes/v1/organizer/app-access.js'
import { adminAppAccessRoutes } from '../../src/routes/v1/admin/app-access.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_EVENT_ID = '99999999-9999-4999-8999-999999999999'
const ORGANIZER_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_ORGANIZER_ID = '33333333-3333-4333-8333-333333333333'

const config = {
  port: 3000,
  databaseUrl: 'mysql://test',
  jwtSecret: JWT_SECRET,
  webhookApiKey: '',
  recommenderUrl: '',
  recommenderTimeoutMs: 1500,
  checkinCooldownSec: 0,
  ratingScale: 3,
  corsOrigin: 'http://localhost:5173',
  adminRegistrationKey: 'k',
  frontendBaseUrl: 'https://front.example',
  organizerSignupMode: 'invite',
} as unknown as import('../../src/config.js').AppConfig

type AccessRowState = {
  event_id: string
  mode: string
  app_opens_at: string | null
  app_closes_at: string | null
  pre_survey_closes_at: string | null
  updated_by: string | null
  updated_at: string
} | null

function makeDb(opts: { access?: AccessRowState; eventExists?: boolean; owner?: string } = {}): DbClient {
  let access: AccessRowState = opts.access ?? null
  const eventExists = opts.eventExists ?? true
  const owner = opts.owner ?? ORGANIZER_ID

  const run = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/SELECT id FROM events WHERE id = \? AND organizer_id = \?/.test(sql)) {
      const [eid, oid] = params
      return [eid === EVENT_ID && oid === owner ? [{ id: eid }] : [], undefined]
    }
    if (/SELECT id FROM events WHERE id = \?/.test(sql)) {
      return [eventExists ? [{ id: params[0] }] : [], undefined]
    }
    if (/SELECT event_id, mode, app_opens_at, app_closes_at, pre_survey_closes_at, updated_by, updated_at\s+FROM event_app_access/.test(sql)) {
      return [access ? [access] : [], undefined]
    }
    if (/INSERT INTO event_app_access/.test(sql)) {
      const [eventId, mode, appOpensAt, appClosesAt, preSurveyClosesAt, updatedBy] = params as string[]
      access = {
        event_id: eventId,
        mode,
        app_opens_at: appOpensAt,
        app_closes_at: appClosesAt,
        pre_survey_closes_at: preSurveyClosesAt,
        updated_by: updatedBy,
        updated_at: '2026-08-24 00:00:00',
      }
      return [{ affectedRows: 1 }, undefined]
    }
    if (/INSERT INTO audit_logs/.test(sql)) {
      return [{ affectedRows: 1 }, undefined]
    }
    throw new Error(`unmatched SQL: ${sql} / ${JSON.stringify(params)}`)
  }
  return { query: run, execute: run, end: async () => {} }
}

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(async (v1) => {
    await v1.register(appAccessRoutes)
    await v1.register(organizerAppAccessRoutes)
    await v1.register(adminAppAccessRoutes)
  }, { prefix: '/api/v1' })
  await app.ready()
  return app
}

function organizerAuthHeader(sub = ORGANIZER_ID) {
  const token = jwt.sign({ sub, scope: 'organizer', display_name: 'Org' }, JWT_SECRET, { expiresIn: '1h' })
  return { authorization: `Bearer ${token}` }
}

function staffAuthHeader(role: 'manager' | 'viewer' = 'viewer') {
  const token = jwt.sign(
    { sub: 'staff-1', event_id: EVENT_ID, display_name: 'Staff', role },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
  return { authorization: `Bearer ${token}` }
}

describe('GET /events/:event_id/app-access（公開）', () => {
  it('存在しない event_id は 404', async () => {
    const app = await buildTestApp(makeDb({ eventExists: false }))
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${EVENT_ID}/app-access` })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('行が無いイベントは closed 扱いで 200', async () => {
    const app = await buildTestApp(makeDb({ access: null }))
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${EVENT_ID}/app-access` })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.mode).toBe('closed')
    expect(data.is_open).toBe(false)
    expect(data.server_time).toBeDefined()
    await app.close()
  })

  it('内部情報（app_closes_at / updated_by）を含まない', async () => {
    const app = await buildTestApp(
      makeDb({
        access: {
          event_id: EVENT_ID,
          mode: 'open',
          app_opens_at: null,
          app_closes_at: '2026-10-16 20:00:00',
          pre_survey_closes_at: null,
          updated_by: ORGANIZER_ID,
          updated_at: '2026-08-24 00:00:00',
        },
      }),
    )
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${EVENT_ID}/app-access` })
    const { data } = res.json()
    expect(data.app_closes_at).toBeUndefined()
    expect(data.updated_by).toBeUndefined()
    await app.close()
  })
})

describe('PUT /organizer/events/:event_id/app-access', () => {
  it('無認証 -> 401', async () => {
    const app = await buildTestApp(makeDb())
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/organizer/events/${EVENT_ID}/app-access`,
      payload: { mode: 'open' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('非所有の organizer -> 403', async () => {
    const app = await buildTestApp(makeDb({ owner: OTHER_ORGANIZER_ID }))
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/organizer/events/${EVENT_ID}/app-access`,
      headers: organizerAuthHeader(),
      payload: { mode: 'open' },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('所有 organizer -> 200 で更新される', async () => {
    const app = await buildTestApp(makeDb())
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/organizer/events/${EVENT_ID}/app-access`,
      headers: organizerAuthHeader(),
      payload: { mode: 'open', pre_survey_closes_at: null },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.mode).toBe('open')
    await app.close()
  })

  it("mode='scheduled' かつ app_opens_at なし -> 400", async () => {
    const app = await buildTestApp(makeDb())
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/organizer/events/${EVENT_ID}/app-access`,
      headers: organizerAuthHeader(),
      payload: { mode: 'scheduled' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('app_closes_at < app_opens_at -> 400', async () => {
    const app = await buildTestApp(makeDb())
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/organizer/events/${EVENT_ID}/app-access`,
      headers: organizerAuthHeader(),
      payload: {
        mode: 'scheduled',
        app_opens_at: '2026-10-16T00:30:00.000Z',
        app_closes_at: '2026-10-16T00:00:00.000Z',
      },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it("mode を open/closed にしても app_opens_at が保持される（null 化しない）", async () => {
    const db = makeDb({
      access: {
        event_id: EVENT_ID,
        mode: 'scheduled',
        app_opens_at: '2026-10-16 00:30:00',
        app_closes_at: null,
        pre_survey_closes_at: null,
        updated_by: null,
        updated_at: '2026-08-24 00:00:00',
      },
    })
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/organizer/events/${EVENT_ID}/app-access`,
      headers: organizerAuthHeader(),
      payload: { mode: 'open' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.app_opens_at).toBe('2026-10-16T00:30:00Z')
    await app.close()
  })
})

describe('GET /admin/events/:event_id/app-access', () => {
  it('viewer で 200', async () => {
    const app = await buildTestApp(makeDb())
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/app-access`,
      headers: staffAuthHeader('viewer'),
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('manager で 200', async () => {
    const app = await buildTestApp(makeDb())
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${EVENT_ID}/app-access`,
      headers: staffAuthHeader('manager'),
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})
