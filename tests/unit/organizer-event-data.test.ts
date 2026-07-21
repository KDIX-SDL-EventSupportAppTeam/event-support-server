import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { organizerEventDataRoutes } from '../../src/routes/v1/organizer/event-data.js'
import { signOrganizerToken, type JwtPayload } from '../../src/lib/jwt.js'

const JWT_SECRET = 'test-secret'
const ORGANIZER_ID = 'org-1'
const EVENT_ID = 'e1'

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
  rows: unknown[] | ((params: unknown[]) => unknown[]) | { affectedRows: number }
}

/** SQL 文字列をパターン照合して結果を返す DbClient モック。`log` に実行 SQL を記録する。 */
function makeDb(handlers: Handler[], log?: string[]): DbClient {
  const run = async (sql: string, params: unknown[] = []) => {
    log?.push(sql)
    const h = handlers.find((x) => x.match.test(sql))
    if (!h) throw new Error(`unmatched SQL: ${sql}`)
    const rows =
      typeof h.rows === 'function'
        ? h.rows(params)
        : h.rows
    return [rows, undefined] as [unknown, unknown]
  }
  return { query: run, execute: run, end: async () => {} }
}

const ownership: Handler = {
  match: /FROM events WHERE id = \? AND organizer_id = \? LIMIT 1/,
  rows: [{ id: EVENT_ID }],
}
const notOwned: Handler = {
  match: /FROM events WHERE id = \? AND organizer_id = \? LIMIT 1/,
  rows: [],
}
const eventExists: Handler = {
  match: /SELECT id FROM events WHERE id = \? LIMIT 1/,
  rows: [{ id: EVENT_ID }],
}
const hasBoothCategories: Handler = {
  match: /information_schema\.tables/,
  rows: [{ c: 1 }],
}
const boothIds: Handler = {
  match: /SELECT id FROM booths WHERE event_id = \?/,
  rows: [{ id: 'b1' }],
}
const deleteHandlers: Handler[] = [
  { match: /^DELETE FROM \w+/, rows: { affectedRows: 2 } },
]
const auditInsert: Handler = {
  match: /^\s*INSERT INTO audit_logs/,
  rows: [],
}

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(
    async (v1) => {
      await v1.register(organizerEventDataRoutes)
    },
    { prefix: '/api/v1' },
  )
  await app.ready()
  return app
}

const organizerAuthHeader = () => ({
  authorization: `Bearer ${signOrganizerToken(JWT_SECRET, ORGANIZER_ID, '主催者')}`,
  'content-type': 'application/json',
})

describe('DELETE /organizer/events/:event_id/event-data', () => {
  it('正常系: 所有イベント＋正しい confirm → 200・cleared 件数一致・DELETE と audit INSERT が発行される', async () => {
    const log: string[] = []
    const db = makeDb(
      [ownership, eventExists, hasBoothCategories, boothIds, auditInsert, ...deleteHandlers],
      log,
    )
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizer/events/${EVENT_ID}/event-data`,
      headers: organizerAuthHeader(),
      payload: { confirm: 'DELETE_ALL_EVENT_DATA' },
    })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.cleared).toEqual({
      recommendations: 2,
      survey_answers: 2,
      ratings: 2,
      checkins: 2,
      booth_tags: 2,
      booth_categories: 2,
      booths: 2,
      participants: 2,
      survey_questions: 2,
      categories: 2,
    })
    expect(log.some((sql) => /^DELETE FROM recommendations/.test(sql))).toBe(true)
    expect(log.some((sql) => /^\s*INSERT INTO audit_logs/.test(sql))).toBe(true)
    await app.close()
  })

  it('confirm 欠落・誤字 → 422、DELETE 系 SQL は 1 本も発行されない', async () => {
    const log: string[] = []
    const db = makeDb([ownership, ...deleteHandlers], log)
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizer/events/${EVENT_ID}/event-data`,
      headers: organizerAuthHeader(),
      payload: { confirm: 'delete_all_event_data' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    expect(log.some((sql) => /^DELETE FROM/.test(sql))).toBe(false)
    await app.close()
  })

  it('confirm 欠落（空 body）→ 422', async () => {
    const db = makeDb([ownership])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizer/events/${EVENT_ID}/event-data`,
      headers: organizerAuthHeader(),
      payload: {},
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('非所有 organizer（所有確認が空）→ 403、DELETE なし', async () => {
    const log: string[] = []
    const db = makeDb([notOwned, ...deleteHandlers], log)
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizer/events/${EVENT_ID}/event-data`,
      headers: organizerAuthHeader(),
      payload: { confirm: 'DELETE_ALL_EVENT_DATA' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
    expect(log.some((sql) => /^DELETE FROM/.test(sql))).toBe(false)
    await app.close()
  })

  it('manager の access token → 401', async () => {
    const db = makeDb([ownership])
    const app = await buildTestApp(db)
    const managerPayload: JwtPayload = {
      sub: 'user-1',
      event_id: EVENT_ID,
      display_name: '運営太郎',
      role: 'manager',
    }
    const managerToken = jwt.sign(managerPayload, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizer/events/${EVENT_ID}/event-data`,
      headers: {
        authorization: `Bearer ${managerToken}`,
        'content-type': 'application/json',
      },
      payload: { confirm: 'DELETE_ALL_EVENT_DATA' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('Authorization ヘッダなし → 401', async () => {
    const db = makeDb([ownership])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizer/events/${EVENT_ID}/event-data`,
      payload: { confirm: 'DELETE_ALL_EVENT_DATA' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('audit INSERT が reject されても本体は 200（削除は成功扱い）', async () => {
    const rejectingAuditDb: Handler = {
      match: /^\s*INSERT INTO audit_logs/,
      rows: () => {
        throw new Error('audit insert failed')
      },
    }
    const db = makeDb([
      ownership,
      eventExists,
      hasBoothCategories,
      boothIds,
      rejectingAuditDb,
      ...deleteHandlers,
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizer/events/${EVENT_ID}/event-data`,
      headers: organizerAuthHeader(),
      payload: { confirm: 'DELETE_ALL_EVENT_DATA' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.cleared.recommendations).toBe(2)
    await app.close()
  })
})
