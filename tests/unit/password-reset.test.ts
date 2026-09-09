import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import type { Mailer } from '../../src/lib/mailer.js'
import { authRoutes } from '../../src/routes/v1/auth.js'

const config = {
  port: 3000,
  databaseUrl: 'mysql://test',
  sakuraProxyUrl: undefined,
  sakuraProxyKey: undefined,
  jwtSecret: 'test-secret',
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
  smtpHost: undefined,
  smtpPort: 587,
  smtpUser: undefined,
  smtpPass: undefined,
  mailFrom: 'PRoToFES <no-reply@example.com>',
} satisfies AppConfig

type Handler = { match: RegExp; rows: unknown[] | ((p: unknown[]) => unknown[]) }

function makeDb(handlers: Handler[], log?: { sql: string; params: unknown[] }[]): DbClient {
  const run = async (sql: string, params: unknown[] = []) => {
    log?.push({ sql, params })
    const h = handlers.find((x) => x.match.test(sql))
    if (!h) throw new Error(`unmatched SQL: ${sql}`)
    return [typeof h.rows === 'function' ? h.rows(params) : h.rows, undefined] as [unknown, unknown]
  }
  return { query: run, execute: run, end: async () => {} }
}

const writeHandlers: Handler[] = [{ match: /^\s*(INSERT|UPDATE|DELETE)/i, rows: [] }]

function makeMailer(shouldThrow = false) {
  const sent: { to: string; subject: string; text: string }[] = []
  const mailer: Mailer = {
    async send(to, subject, text) {
      if (shouldThrow) throw new Error('smtp down')
      sent.push({ to, subject, text })
    },
  }
  return { mailer, sent }
}

async function buildApp(db: DbClient, mailer: Mailer): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  app.decorate('mailer', mailer)
  await app.register(async (v1) => { await v1.register(authRoutes, { prefix: '/auth' }) }, { prefix: '/api/v1' })
  await app.ready()
  return app
}

const EVENT_ID = '20000000-0000-4000-8000-000000000001'
const HEX64 = 'a'.repeat(64)
const userLookup = (rows: unknown[]): Handler => ({
  match: /SELECT id, display_name FROM users WHERE event_id = \? AND email = \?/,
  rows,
})

describe('POST /auth/forgot-password（issue #125）', () => {
  it('登録済みメールで 200・メール送信・旧トークン削除→新規発行（T-1）', async () => {
    const log: { sql: string; params: unknown[] }[] = []
    const db = makeDb([userLookup([{ id: 'u1', display_name: '本人' }]), ...writeHandlers], log)
    const { mailer, sent } = makeMailer()
    const app = await buildApp(db, mailer)
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/forgot-password',
      payload: { event_id: EVENT_ID, email: 'known@example.com' },
    })
    expect(res.statusCode).toBe(200)
    expect(sent).toHaveLength(1)
    expect(log.some((e) => /DELETE FROM password_reset_tokens WHERE user_id = \?/.test(e.sql))).toBe(true)
    expect(log.some((e) => /INSERT INTO password_reset_tokens/.test(e.sql))).toBe(true)
    await app.close()
  })

  it('未登録メールでも同じ 200・同じ本文・メールは送らない（T-2 / T-10）', async () => {
    const dbKnown = makeDb([userLookup([{ id: 'u1', display_name: '本人' }]), ...writeHandlers])
    const dbUnknown = makeDb([userLookup([]), ...writeHandlers])
    const mKnown = makeMailer()
    const mUnknown = makeMailer()
    const appKnown = await buildApp(dbKnown, mKnown.mailer)
    const appUnknown = await buildApp(dbUnknown, mUnknown.mailer)
    const known = await appKnown.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { event_id: EVENT_ID, email: 'known@example.com' } })
    const unknown = await appUnknown.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { event_id: EVENT_ID, email: 'nobody@example.com' } })
    expect(unknown.statusCode).toBe(200)
    expect(unknown.body).toBe(known.body) // 同じ文言
    expect(mUnknown.sent).toHaveLength(0)
    expect(unknown.body).not.toMatch(/[0-9a-f]{64}/) // トークンを漏らさない
    await appKnown.close(); await appUnknown.close()
  })

  it('event_id と email の両方で引く（T-3: 別イベントの同名アドレスに影響しない）', async () => {
    const log: { sql: string; params: unknown[] }[] = []
    const db = makeDb([userLookup([]), ...writeHandlers], log)
    const app = await buildApp(db, makeMailer().mailer)
    await app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { event_id: EVENT_ID, email: 'x@example.com' } })
    const lookup = log.find((e) => /WHERE event_id = \? AND email = \?/.test(e.sql))!
    expect(lookup.params).toEqual([EVENT_ID, 'x@example.com'])
    await app.close()
  })

  it('送信失敗でも 200（存在を漏らさない・T-1 補足）', async () => {
    const db = makeDb([userLookup([{ id: 'u1', display_name: '本人' }]), ...writeHandlers])
    const app = await buildApp(db, makeMailer(true).mailer)
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/forgot-password', payload: { event_id: EVENT_ID, email: 'known@example.com' } })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe('POST /auth/reset-password（issue #125）', () => {
  const future = new Date(Date.now() + 3600_000).toISOString().slice(0, 19).replace('T', ' ')
  const tokenLookup = (rows: unknown[]): Handler => ({
    match: /SELECT user_id, expires_at FROM password_reset_tokens WHERE token = \?/,
    rows,
  })

  it('有効なトークンでパスワードを更新し、トークンを消す。email_verified_at は触らない（T-4 / T-11）', async () => {
    const log: { sql: string; params: unknown[] }[] = []
    const db = makeDb([tokenLookup([{ user_id: 'u1', expires_at: future }]), ...writeHandlers], log)
    const app = await buildApp(db, makeMailer().mailer)
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/reset-password',
      payload: { token: HEX64, password: 'newpassword1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ reset: true })
    expect(log.some((e) => /UPDATE users SET password_hash = \? WHERE id = \?/.test(e.sql))).toBe(true)
    expect(log.some((e) => /DELETE FROM password_reset_tokens WHERE user_id = \?/.test(e.sql))).toBe(true)
    expect(log.some((e) => /email_verified_at/.test(e.sql))).toBe(false)
    await app.close()
  })

  it('存在しない／使用済みトークンは 410 TOKEN_EXPIRED（T-5）', async () => {
    const db = makeDb([tokenLookup([]), ...writeHandlers])
    const app = await buildApp(db, makeMailer().mailer)
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token: HEX64, password: 'newpassword1' } })
    expect(res.statusCode).toBe(410)
    expect(res.json().error.code).toBe('TOKEN_EXPIRED')
    await app.close()
  })

  it('期限切れトークンは 410 で、そのトークンを削除する（T-6）', async () => {
    const log: { sql: string; params: unknown[] }[] = []
    const db = makeDb([tokenLookup([{ user_id: 'u1', expires_at: '2020-01-01 00:00:00' }]), ...writeHandlers], log)
    const app = await buildApp(db, makeMailer().mailer)
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token: HEX64, password: 'newpassword1' } })
    expect(res.statusCode).toBe(410)
    expect(log.some((e) => /DELETE FROM password_reset_tokens WHERE token = \?/.test(e.sql))).toBe(true)
    await app.close()
  })

  it('8文字未満のパスワードは 422（T-8）', async () => {
    const db = makeDb([tokenLookup([{ user_id: 'u1', expires_at: future }]), ...writeHandlers])
    const app = await buildApp(db, makeMailer().mailer)
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token: HEX64, password: 'short' } })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('64桁hex 以外のトークンは 422（T-9）', async () => {
    const db = makeDb([tokenLookup([]), ...writeHandlers])
    const app = await buildApp(db, makeMailer().mailer)
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/reset-password', payload: { token: 'xyz', password: 'newpassword1' } })
    expect(res.statusCode).toBe(422)
    await app.close()
  })
})
