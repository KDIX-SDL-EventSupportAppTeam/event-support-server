import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Server } from 'socket.io'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { checkinRoutes } from '../../src/routes/v1/checkins.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999'
const BOOTH_ID = '33333333-3333-4333-8333-333333333333'
const CARD_ID = '44444444-4444-4444-8444-444444444444'
const CHECKIN_ID = '55555555-5555-4555-8555-555555555555'

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
  ratingScale: 4,
  corsOrigin: 'http://localhost:5173',
  adminRegistrationKey: 'k',
  frontendBaseUrl: 'https://front.example',
  organizerRegistrationKey: undefined,
  organizerSignupMode: 'invite',
} as AppConfig

function authHeader(userId: string = USER_ID): Record<string, string> {
  const token = jwt.sign(
    { sub: userId, event_id: EVENT_ID, display_name: 'テスト太郎', role: 'participant' },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

const fakeIo = {
  to: () => ({ emit: () => {} }),
} as unknown as Server

/** POST /checkins（後出し割当なし・シンプルな経路）と GET /checkins・rating 用の最小 DB モック */
function makeDb(opts: {
  ratedCheckinId?: string | null
} = {}): DbClient {
  const ratings = new Map<string, { id: string }>()
  if (opts.ratedCheckinId) ratings.set(opts.ratedCheckinId, { id: 'rating-existing' })

  const run = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/SELECT role, email_verified_at FROM users/.test(sql)) {
      return [[{ role: 'participant', email_verified_at: '2026-08-01 00:00:00' }], undefined]
    }
    if (/SELECT id, name FROM booths WHERE id = \? AND event_id = \? AND is_active = 1/.test(sql)) {
      return [[{ id: BOOTH_ID, name: 'テストブース' }], undefined]
    }
    if (/SELECT id FROM bingo_cards WHERE event_id = \? AND user_id = \?/.test(sql)) {
      return [[{ id: CARD_ID }], undefined]
    }
    if (/SELECT COUNT\(\*\) AS c FROM bingo_cells WHERE card_id = \?/.test(sql)) {
      return [[{ c: 16 }], undefined]
    }
    if (/SELECT id FROM check_ins WHERE user_id = \? AND booth_id = \?/.test(sql)) {
      return [[], undefined]
    }
    if (/COALESCE\(MAX\(visit_order\),0\)/.test(sql)) {
      return [[{ m: 0 }], undefined]
    }
    if (/SELECT position FROM bingo_cells WHERE card_id = \? AND is_achieved = 1/.test(sql)) {
      return [[], undefined]
    }
    if (/INSERT INTO check_ins/.test(sql)) {
      return [{ affectedRows: 1 }, undefined]
    }
    if (/SELECT id, position, zone FROM bingo_cells\s+WHERE card_id = \? AND booth_id = \? AND is_revealed = 1 AND is_achieved = 0/.test(sql)) {
      return [[], undefined]
    }
    if (/SELECT id, position FROM bingo_cells\s+WHERE card_id = \? AND zone = 'CENTER' AND booth_id IS NULL/.test(sql)) {
      return [[], undefined] // 中央マスに空きなし → filled_cell は null のまま
    }
    if (/SELECT ci\.id, ci\.booth_id, b\.name AS booth_name, ci\.checkin_method, ci\.checked_in_at, ci\.synced_at/.test(sql)) {
      return [
        [
          {
            id: CHECKIN_ID,
            booth_id: BOOTH_ID,
            booth_name: 'テストブース',
            checkin_method: 'qr',
            checked_in_at: '2026-09-20 01:00:00',
            synced_at: '2026-09-20 01:00:00',
            rating_id: ratings.has(CHECKIN_ID) ? ratings.get(CHECKIN_ID)!.id : null,
          },
        ],
        undefined,
      ]
    }
    if (/SELECT ci\.booth_id, b\.name AS booth_name\s+FROM check_ins ci\s+JOIN booths b ON b\.id = ci\.booth_id\s+WHERE ci\.id = \? AND ci\.user_id = \? AND ci\.event_id = \?/.test(sql)) {
      const [checkinId, userId] = params as [string, string]
      if (checkinId === CHECKIN_ID && userId === USER_ID) {
        return [[{ booth_id: BOOTH_ID, booth_name: 'テストブース' }], undefined]
      }
      return [[], undefined]
    }
    if (/SELECT id FROM booth_ratings WHERE checkin_id = \?/.test(sql)) {
      const [checkinId] = params as [string]
      return [ratings.has(checkinId) ? [{ id: ratings.get(checkinId)!.id }] : [], undefined]
    }
    if (/INSERT INTO booth_ratings/.test(sql)) {
      const [, , , , checkinId] = params as string[]
      ratings.set(checkinId, { id: 'new-rating' })
      return [{ affectedRows: 1 }, undefined]
    }
    throw new Error(`unmatched SQL: ${sql} / ${JSON.stringify(params)}`)
  }
  return { query: run, execute: run, end: async () => {} } as DbClient
}

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  app.decorate('io', fakeIo)
  await app.register(async (v1) => {
    await v1.register(checkinRoutes)
  }, { prefix: '/api/v1' })
  await app.ready()
  return app
}

describe('GET /events/:event_id/checkins の rated（#133 D1）', () => {
  it('T-1: 未評価のチェックインは rated: false。評価後は rated: true', async () => {
    const dbBefore = makeDb({ ratedCheckinId: null })
    const appBefore = await buildTestApp(dbBefore)
    const resBefore = await appBefore.inject({
      method: 'GET',
      url: `/api/v1/events/${EVENT_ID}/checkins`,
      headers: authHeader(),
    })
    expect(resBefore.json().data.checkins[0].rated).toBe(false)
    await appBefore.close()

    const dbAfter = makeDb({ ratedCheckinId: CHECKIN_ID })
    const appAfter = await buildTestApp(dbAfter)
    const resAfter = await appAfter.inject({
      method: 'GET',
      url: `/api/v1/events/${EVENT_ID}/checkins`,
      headers: authHeader(),
    })
    expect(resAfter.json().data.checkins[0].rated).toBe(true)
    await appAfter.close()
  })
})

describe('POST /events/:event_id/checkins/:checkin_id/rating（#133）', () => {
  it('T-2: 同じ checkin_id に2回評価すると2回目は409。booth_ratings は1行のまま', async () => {
    const db = makeDb()
    const app = await buildTestApp(db)

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins/${CHECKIN_ID}/rating`,
      headers: authHeader(),
      payload: { rating: 3 },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins/${CHECKIN_ID}/rating`,
      headers: authHeader(),
      payload: { rating: 4 },
    })
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('CONFLICT')
    await app.close()
  })

  it('T-3: 他人の checkin_id に評価すると404。行は作られない', async () => {
    const db = makeDb()
    const app = await buildTestApp(db)

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins/${CHECKIN_ID}/rating`,
      headers: authHeader(OTHER_USER_ID),
      payload: { rating: 3 },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
    await app.close()
  })

  it("T-4: context: 'IMMEDIATE' は prompt_context = 'IMMEDIATE' で保存される", async () => {
    const db = makeDb()
    const insertedContexts: unknown[] = []
    const originalExecute = db.execute.bind(db)
    db.execute = (async (sql: string, params: unknown[]) => {
      if (/INSERT INTO booth_ratings/.test(sql)) {
        insertedContexts.push((params as unknown[])[7])
      }
      return originalExecute(sql, params)
    }) as DbClient['execute']

    const res = await app_inject(db, { rating: 2, context: 'IMMEDIATE' })
    expect(res.statusCode).toBe(200)
    expect(insertedContexts).toEqual(['IMMEDIATE'])
  })

  it("T-5: context 省略時は 'MANUAL' で保存される", async () => {
    const db = makeDb()
    const insertedContexts: unknown[] = []
    const originalExecute = db.execute.bind(db)
    db.execute = (async (sql: string, params: unknown[]) => {
      if (/INSERT INTO booth_ratings/.test(sql)) {
        insertedContexts.push((params as unknown[])[7])
      }
      return originalExecute(sql, params)
    }) as DbClient['execute']

    const res = await app_inject(db, { rating: 2 })
    expect(res.statusCode).toBe(200)
    expect(insertedContexts).toEqual(['MANUAL'])
  })

  it("T-6: context: 'NEXT_CHECKIN' は422になる", async () => {
    const db = makeDb()
    const res = await app_inject(db, { rating: 2, context: 'NEXT_CHECKIN' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })
})

async function app_inject(db: DbClient, payload: unknown) {
  const app = await buildTestApp(db)
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/events/${EVENT_ID}/checkins/${CHECKIN_ID}/rating`,
    headers: authHeader(),
    payload,
  })
  await app.close()
  return res
}

describe('POST /events/:event_id/checkins（#133 D3）', () => {
  it('T-7: レスポンスに pending_rating キーが存在しない', async () => {
    const db = makeDb()
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins`,
      headers: authHeader(),
      payload: { method: 'qr', booth_id: BOOTH_ID, checked_in_at: '2026-09-20T01:00:00Z' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).not.toHaveProperty('pending_rating')
    await app.close()
  })
})
