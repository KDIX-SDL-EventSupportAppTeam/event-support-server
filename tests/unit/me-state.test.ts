import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import Fastify, { type FastifyInstance } from 'fastify'
import type { DbClient } from '../../src/db/client.js'
import { meRoutes } from '../../src/routes/v1/me.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_EVENT_ID = '99999999-9999-4999-8999-999999999999'
const USER_ID = '22222222-2222-4222-8222-222222222222'

const config = {
  jwtSecret: JWT_SECRET,
} as unknown as import('../../src/config.js').AppConfig

type Fixture = {
  emailVerifiedAt?: string | null
  answeredAt?: string | null
  onboardingCompletedAt?: string | null
  mode?: string
  appOpensAt?: string | null
}

function makeDb(fx: Fixture = {}): DbClient {
  let onboardingAt: string | null = fx.onboardingCompletedAt ?? null

  const run = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/UPDATE users SET onboarding_completed_at/.test(sql)) {
      // 条件付き UPDATE: 既に打刻済みなら上書きしない
      if (onboardingAt === null) onboardingAt = params[0] as string
      return [{ affectedRows: 1 }, undefined]
    }
    if (/SELECT onboarding_completed_at FROM users/.test(sql)) {
      return [[{ onboarding_completed_at: onboardingAt }], undefined]
    }
    if (/SELECT email_verified_at, onboarding_completed_at FROM users/.test(sql)) {
      return [
        [{ email_verified_at: fx.emailVerifiedAt ?? null, onboarding_completed_at: onboardingAt }],
        undefined,
      ]
    }
    if (/SELECT created_at FROM user_survey_answers/.test(sql)) {
      const [uid, eid] = params
      const hit = uid === USER_ID && eid === EVENT_ID && fx.answeredAt !== undefined && fx.answeredAt !== null
      return [hit ? [{ created_at: fx.answeredAt }] : [], undefined]
    }
    if (/FROM event_app_access/.test(sql)) {
      return [
        [
          {
            event_id: EVENT_ID,
            mode: fx.mode ?? 'closed',
            app_opens_at: fx.appOpensAt ?? null,
            app_closes_at: null,
            pre_survey_closes_at: null,
            updated_by: null,
            updated_at: '2026-08-24 00:00:00',
          },
        ],
        undefined,
      ]
    }
    return [[], undefined]
  }
  return { query: run, execute: run } as unknown as DbClient
}

async function buildApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(meRoutes)
  await app.ready()
  return app
}

function tokenFor(eventId: string): string {
  return jwt.sign({ sub: USER_ID, event_id: eventId, role: 'participant' }, JWT_SECRET, {
    expiresIn: '1h',
  })
}

async function get(app: FastifyInstance, eventId: string, token?: string) {
  return app.inject({
    method: 'GET',
    url: `/events/${eventId}/me/state`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('GET /events/:event_id/me/state', () => {
  it('未認証は 401 を返す', async () => {
    const app = await buildApp(makeDb())
    const res = await get(app, EVENT_ID)
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('JWT と異なるイベントの状態は取得できない', async () => {
    const app = await buildApp(makeDb())
    const res = await get(app, OTHER_EVENT_ID, tokenFor(EVENT_ID))
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('メール未確認・未回答なら両方 false を返す', async () => {
    const app = await buildApp(makeDb())
    const res = await get(app, EVENT_ID, tokenFor(EVENT_ID))
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.email_verified).toBe(false)
    expect(data.survey_answered).toBe(false)
    expect(data.survey_answered_at).toBeNull()
    await app.close()
  })

  it('メール確認済み・回答済みなら true と回答時刻を ISO で返す', async () => {
    const app = await buildApp(
      makeDb({ emailVerifiedAt: '2026-08-20 01:00:00', answeredAt: '2026-08-20 09:12:00' }),
    )
    const res = await get(app, EVENT_ID, tokenFor(EVENT_ID))
    const { data } = res.json()
    expect(data.email_verified).toBe(true)
    expect(data.survey_answered).toBe(true)
    expect(data.survey_answered_at).toBe('2026-08-20T09:12:00Z')
    await app.close()
  })

  it('オンボーディング未完了なら false を返す', async () => {
    const app = await buildApp(makeDb())
    const res = await get(app, EVENT_ID, tokenFor(EVENT_ID))
    expect(res.json().data.onboarding_completed).toBe(false)
    await app.close()
  })

  it('オンボーディング完了済みなら true を返す', async () => {
    const app = await buildApp(makeDb({ onboardingCompletedAt: '2026-10-16 01:00:00' }))
    const res = await get(app, EVENT_ID, tokenFor(EVENT_ID))
    expect(res.json().data.onboarding_completed).toBe(true)
    await app.close()
  })

  it('アプリ公開ゲートの実効状態を同じ応答に載せる', async () => {
    const app = await buildApp(makeDb({ mode: 'open' }))
    const res = await get(app, EVENT_ID, tokenFor(EVENT_ID))
    const { data } = res.json()
    expect(data.app_access.is_open).toBe(true)
    expect(data.app_access.mode).toBe('open')
    expect(typeof data.app_access.server_time).toBe('string')
    await app.close()
  })
})

describe('POST /events/:event_id/me/onboarding', () => {
  async function post(app: FastifyInstance, eventId: string, token?: string) {
    return app.inject({
      method: 'POST',
      url: `/events/${eventId}/me/onboarding`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  }

  it('未認証は 401 を返す', async () => {
    const app = await buildApp(makeDb())
    expect((await post(app, EVENT_ID)).statusCode).toBe(401)
    await app.close()
  })

  it('打刻すると me/state が completed を返すようになる', async () => {
    const db = makeDb()
    const app = await buildApp(db)
    expect((await get(app, EVENT_ID, tokenFor(EVENT_ID))).json().data.onboarding_completed).toBe(false)

    const res = await post(app, EVENT_ID, tokenFor(EVENT_ID))
    expect(res.statusCode).toBe(200)
    expect(res.json().data.onboarding_completed).toBe(true)

    expect((await get(app, EVENT_ID, tokenFor(EVENT_ID))).json().data.onboarding_completed).toBe(true)
    await app.close()
  })

  it('2 回目の打刻は初回の時刻を上書きしない', async () => {
    const app = await buildApp(makeDb({ onboardingCompletedAt: '2026-10-16 01:00:00' }))
    const res = await post(app, EVENT_ID, tokenFor(EVENT_ID))
    expect(res.json().data.onboarding_completed_at).toBe('2026-10-16T01:00:00Z')
    await app.close()
  })
})
