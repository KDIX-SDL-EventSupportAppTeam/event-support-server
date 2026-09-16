import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import type { Mailer } from '../../src/lib/mailer.js'
import { authRoutes } from '../../src/routes/v1/auth.js'
import { checkinRoutes } from '../../src/routes/v1/checkins.js'

const JWT_SECRET = 'test-secret'

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
  smtpHost: undefined,
  smtpPort: 587,
  smtpUser: undefined,
  smtpPass: undefined,
  mailFrom: 'PRoToFES <no-reply@example.com>',
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

/** 送信を記録し、必要なら throw するフェイク Mailer。 */
function makeMailer(shouldThrow = false): { mailer: Mailer; sent: { to: string; subject: string; text: string }[] } {
  const sent: { to: string; subject: string; text: string }[] = []
  return {
    mailer: {
      async send(to, subject, text) {
        if (shouldThrow) throw new Error('smtp down')
        sent.push({ to, subject, text })
      },
    },
    sent,
  }
}

async function buildTestApp(db: DbClient, mailer: Mailer): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  app.decorate('mailer', mailer)
  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: '/auth' })
      await v1.register(checkinRoutes)
    },
    { prefix: '/api/v1' },
  )
  await app.ready()
  return app
}

function makeParticipantToken(uid: string, eventId: string, role: 'participant' | 'manager' = 'participant') {
  return jwt.sign({ sub: uid, event_id: eventId, display_name: '本人', role }, JWT_SECRET, {
    algorithm: 'HS256',
  })
}

const EVENT_ID = 'event-1'

describe('POST /auth/register（メール確認トークン発行）', () => {
  const eventExists: Handler = { match: /SELECT id FROM events WHERE id = \?\s+LIMIT 1/, rows: [{ id: EVENT_ID }] }
  const dupCheck: Handler = { match: /SELECT id FROM users WHERE event_id = \? AND email = \?\s+LIMIT 1/, rows: [] }
  const dateEnd: Handler = {
    match: /SELECT date_end FROM events WHERE id = \?\s+LIMIT 1/,
    rows: [{ date_end: '2026-12-31 23:59:59' }],
  }

  it('登録成功でトークン INSERT とメール send が呼ばれ、応答に email_verified:false が入る', async () => {
    const log: string[] = []
    const db = makeDb([eventExists, dupCheck, dateEnd, ...writeHandlers], log)
    const { mailer, sent } = makeMailer()
    const app = await buildTestApp(db, mailer)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        event_id: '20000000-0000-4000-8000-000000000001',
        email: 'new@example.com',
        password: 'password123',
        display_name: '新規参加者',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.user.email_verified).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('new@example.com')
    expect(log.some((sql) => /INSERT INTO email_verification_tokens/.test(sql))).toBe(true)
    expect(log.some((sql) => /DELETE FROM email_verification_tokens WHERE user_id = \?/.test(sql))).toBe(true)
    await app.close()
  })

  it('send が throw しても register は 200 のまま成功する（副作用の失敗で本体を巻き戻さない）', async () => {
    const db = makeDb([eventExists, dupCheck, dateEnd, ...writeHandlers])
    const { mailer } = makeMailer(true)
    const app = await buildTestApp(db, mailer)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        event_id: '20000000-0000-4000-8000-000000000001',
        email: 'new2@example.com',
        password: 'password123',
        display_name: '新規参加者2',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.user.email_verified).toBe(false)
    await app.close()
  })
})

describe('GET /auth/verify-email', () => {
  it('有効なトークンは 200 verified:true を返し、UPDATE と DELETE が発行される', async () => {
    const log: string[] = []
    const future = new Date(Date.now() + 3600_000).toISOString().slice(0, 19).replace('T', ' ')
    const db = makeDb(
      [
        { match: /SELECT user_id, expires_at FROM email_verification_tokens WHERE token = \?/, rows: [{ user_id: 'u1', expires_at: future }] },
        ...writeHandlers,
      ],
      log,
    )
    const { mailer } = makeMailer()
    const app = await buildTestApp(db, mailer)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/verify-email?token=${'a'.repeat(64)}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ verified: true })
    expect(log.some((sql) => /UPDATE users SET email_verified_at = \? WHERE id = \? AND email_verified_at IS NULL/.test(sql))).toBe(true)
    expect(log.some((sql) => /DELETE FROM email_verification_tokens WHERE user_id = \?/.test(sql))).toBe(true)
    await app.close()
  })

  it('未知のトークンは 404 TOKEN_INVALID', async () => {
    const db = makeDb([
      { match: /SELECT user_id, expires_at FROM email_verification_tokens WHERE token = \?/, rows: [] },
    ])
    const { mailer } = makeMailer()
    const app = await buildTestApp(db, mailer)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/verify-email?token=${'b'.repeat(64)}`,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('TOKEN_INVALID')
    await app.close()
  })

  it('期限切れトークンは 410 TOKEN_EXPIRED を返し、該当トークンを DELETE する', async () => {
    const log: string[] = []
    const db = makeDb(
      [
        { match: /SELECT user_id, expires_at FROM email_verification_tokens WHERE token = \?/, rows: [{ user_id: 'u1', expires_at: '2020-01-01 00:00:00' }] },
        ...writeHandlers,
      ],
      log,
    )
    const { mailer } = makeMailer()
    const app = await buildTestApp(db, mailer)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/verify-email?token=${'c'.repeat(64)}`,
    })
    expect(res.statusCode).toBe(410)
    expect(res.json().error.code).toBe('TOKEN_EXPIRED')
    expect(log.some((sql) => /DELETE FROM email_verification_tokens WHERE token = \?/.test(sql))).toBe(true)
    await app.close()
  })

  it('形式不正なトークンは 422 VALIDATION_ERROR', async () => {
    const db = makeDb([])
    const { mailer } = makeMailer()
    const app = await buildTestApp(db, mailer)
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/verify-email?token=xyz' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    await app.close()
  })
})

describe('POST /auth/resend-verification', () => {
  const uid = 'u1'
  const token = jwt.sign({ sub: uid, event_id: EVENT_ID, display_name: '本人', role: 'participant' }, JWT_SECRET, {
    algorithm: 'HS256',
  })

  it('未確認ユーザーは旧トークンを削除して新規発行し、メールを送信する', async () => {
    const log: string[] = []
    const db = makeDb(
      [
        { match: /SELECT email, display_name, email_verified_at FROM users WHERE id = \?/, rows: [{ email: 'u1@example.com', display_name: '本人', email_verified_at: null }] },
        ...writeHandlers,
      ],
      log,
    )
    const { mailer, sent } = makeMailer()
    const app = await buildTestApp(db, mailer)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/resend-verification',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ sent: true })
    expect(sent).toHaveLength(1)
    expect(log.some((sql) => /DELETE FROM email_verification_tokens WHERE user_id = \?/.test(sql))).toBe(true)
    expect(log.some((sql) => /INSERT INTO email_verification_tokens/.test(sql))).toBe(true)
    await app.close()
  })

  it('確認済みユーザーは 409 ALREADY_VERIFIED', async () => {
    const db = makeDb([
      { match: /SELECT email, display_name, email_verified_at FROM users WHERE id = \?/, rows: [{ email: 'u1@example.com', display_name: '本人', email_verified_at: '2026-01-01 00:00:00' }] },
    ])
    const { mailer } = makeMailer()
    const app = await buildTestApp(db, mailer)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/resend-verification',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('ALREADY_VERIFIED')
    await app.close()
  })

  it('Bearer 無しは 401 UNAUTHORIZED', async () => {
    const db = makeDb([])
    const { mailer } = makeMailer()
    const app = await buildTestApp(db, mailer)
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/resend-verification' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})

describe('requireVerifiedEmail（POST checkins の preHandler）', () => {
  it('未確認 participant は 403 EMAIL_NOT_VERIFIED', async () => {
    const db = makeDb([
      { match: /SELECT role, email_verified_at FROM users WHERE id = \?/, rows: [{ role: 'participant', email_verified_at: null }] },
    ])
    const { mailer } = makeMailer()
    const app = await buildTestApp(db, mailer)
    const token = makeParticipantToken('u1', EVENT_ID, 'participant')
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED')
    await app.close()
  })

  it('確認済み participant は preHandler を素通りし、後続のバリデーションまで進む', async () => {
    const db = makeDb([
      { match: /SELECT role, email_verified_at FROM users WHERE id = \?/, rows: [{ role: 'participant', email_verified_at: '2026-01-01 00:00:00' }] },
    ])
    const { mailer } = makeMailer()
    const app = await buildTestApp(db, mailer)
    const token = makeParticipantToken('u1', EVENT_ID, 'participant')
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    // 403 にならず、素通りして checkinBody のバリデーションエラー（422）に到達する
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    await app.close()
  })

  it('未確認 manager は制限対象外で preHandler を素通りする', async () => {
    const db = makeDb([
      { match: /SELECT role, email_verified_at FROM users WHERE id = \?/, rows: [{ role: 'manager', email_verified_at: null }] },
    ])
    const { mailer } = makeMailer()
    const app = await buildTestApp(db, mailer)
    const token = makeParticipantToken('m1', EVENT_ID, 'manager')
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    await app.close()
  })
})
