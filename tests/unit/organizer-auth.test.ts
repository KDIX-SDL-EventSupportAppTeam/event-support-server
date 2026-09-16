import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { organizerAuthRoutes } from '../../src/routes/v1/organizer/auth.js'

const JWT_SECRET = 'test-secret'
const VALID_KEY = 'valid-organizer-key'

function makeConfig(mode: AppConfig['organizerSignupMode']): AppConfig {
  return {
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
    organizerRegistrationKey: VALID_KEY,
    organizerSignupMode: mode,
  }
}

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

async function buildTestApp(mode: AppConfig['organizerSignupMode'], db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', makeConfig(mode))
  app.decorate('db', db)
  await app.register(
    async (v1) => {
      await v1.register(organizerAuthRoutes)
    },
    { prefix: '/api/v1' },
  )
  await app.ready()
  return app
}

const registerPayload = { email: 'new-organizer@example.com', password: 'password123' }

describe('POST /organizer/auth/register（ORGANIZER_SIGNUP_MODE=disabled）', () => {
  it('410 GONE を返し、DB アクセスが一切発生しない', async () => {
    const log: string[] = []
    const app = await buildTestApp('disabled', makeDb([], log))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/organizer/auth/register',
      payload: registerPayload,
    })
    expect(res.statusCode).toBe(410)
    expect(res.json()).toEqual({
      success: false,
      error: { code: 'GONE', message: 'オーガナイザー登録は現在受け付けていません' },
    })
    expect(log).toHaveLength(0)
    await app.close()
  })

  it('正しい x-organizer-key を付けても 410（キーでは迂回できない）', async () => {
    const app = await buildTestApp('disabled', makeDb([]))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/organizer/auth/register',
      headers: { 'x-organizer-key': VALID_KEY },
      payload: registerPayload,
    })
    expect(res.statusCode).toBe(410)
    await app.close()
  })

  it('login は disabled でも従来どおり 200（既存 organizer は使い続けられる）', async () => {
    const hash = bcrypt.hashSync('password123', 4)
    const app = await buildTestApp('disabled', makeDb([
      {
        match: /FROM organizers WHERE email = \? LIMIT 1/,
        rows: [{ id: 'org-1', email: 'dev@example.com', password_hash: hash, display_name: '開発者' }],
      },
    ]))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/organizer/auth/login',
      payload: { email: 'dev@example.com', password: 'password123' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.token).toBeTruthy()
    await app.close()
  })
})

describe('POST /organizer/auth/register（既存モードの回帰）', () => {
  it('invite: キー不一致は従来どおり 403 FORBIDDEN', async () => {
    const app = await buildTestApp('invite', makeDb([]))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/organizer/auth/register',
      headers: { 'x-organizer-key': 'wrong-key' },
      payload: registerPayload,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
    await app.close()
  })

  it('invite: 正しいキーなら従来どおり 201 で token を返す', async () => {
    const app = await buildTestApp('invite', makeDb([
      { match: /SELECT id FROM organizers WHERE email = \? LIMIT 1/, rows: [] },
      { match: /^\s*INSERT INTO organizers/i, rows: [] },
    ]))
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/organizer/auth/register',
      headers: { 'x-organizer-key': VALID_KEY },
      payload: registerPayload,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.token).toBeTruthy()
    await app.close()
  })
})
