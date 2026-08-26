import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { adminBingoRoutes } from '../../src/routes/v1/admin/bingo.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const MANAGER_ID = '22222222-2222-4222-8222-222222222222'
const FROM_BOOTH = '33333333-3333-4333-8333-333333333333'
const REPLACEMENT_BOOTH = '44444444-4444-4444-8444-444444444444'

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
  organizerSignupMode: 'invite',
} as AppConfig

type Options = {
  /** is_revealed=1,is_achieved=0 で from_booth_id が載っているマス */
  targets?: { id: string; card_id: string }[]
  /** フォールバック候補として返すブース（訪問者数昇順） */
  fallbackCandidates?: { id: string; visitors: number }[]
  /** UPDATE bingo_cells の affectedRows（競合シミュレーション用） */
  updateAffected?: number
}

function makeDb(log: string[], opts: Options = {}): DbClient {
  const {
    targets = [{ id: 'cell-1', card_id: 'card-1' }],
    fallbackCandidates = [{ id: REPLACEMENT_BOOTH, visitors: 0 }],
    updateAffected = 1,
  } = opts
  const run = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    log.push(sql.trim())
    if (/SELECT c\.id, c\.card_id FROM bingo_cells c/.test(sql)) {
      return [targets, undefined]
    }
    if (/SELECT booth_id FROM bingo_cells WHERE card_id = \? AND booth_id IS NOT NULL/.test(sql)) {
      return [[], undefined]
    }
    if (/SELECT b\.id, COUNT\(u\.id\) AS visitors\s+FROM booths b/.test(sql)) {
      return [fallbackCandidates, undefined]
    }
    if (/UPDATE bingo_cells SET booth_id = \?, assigned_at = \?/.test(sql)) {
      return [{ affectedRows: updateAffected }, undefined]
    }
    if (/INSERT INTO audit_logs/.test(sql)) {
      return [{ affectedRows: 1 }, undefined]
    }
    throw new Error(`unmatched SQL: ${sql} / ${JSON.stringify(params)}`)
  }
  return { query: run, execute: run, end: async () => {} }
}

function authHeader(): Record<string, string> {
  const token = jwt.sign(
    { sub: MANAGER_ID, event_id: EVENT_ID, display_name: '運営', role: 'manager' },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function buildTestApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(async (v1) => {
    await v1.register(adminBingoRoutes)
  }, { prefix: '/api/v1' })
  await app.ready()
  return app
}

async function post(app: FastifyInstance, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/events/${EVENT_ID}/admin/bingo/reassign`,
    headers: authHeader(),
    payload: payload as Record<string, unknown>,
  })
}

describe('POST /events/:event_id/admin/bingo/reassign', () => {
  it('入力不正（booth_id が UUID でない）なら 422', async () => {
    const log: string[] = []
    const app = await buildTestApp(makeDb(log))
    const res = await post(app, { booth_id: 'not-a-uuid' })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('対象マスが無ければ 0 件で返す', async () => {
    const log: string[] = []
    const app = await buildTestApp(makeDb(log, { targets: [] }))
    const res = await post(app, { booth_id: FROM_BOOTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ affected_cards: 0, reassigned_cells: 0, cleared_cells: 0 })
    await app.close()
  })

  it('正常系: フォールバック候補で差し替え、reassigned_cells に計上する', async () => {
    const log: string[] = []
    const app = await buildTestApp(
      makeDb(log, {
        targets: [{ id: 'cell-1', card_id: 'card-1' }],
        fallbackCandidates: [{ id: REPLACEMENT_BOOTH, visitors: 0 }],
        updateAffected: 1,
      }),
    )
    const res = await post(app, { booth_id: FROM_BOOTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ affected_cards: 1, reassigned_cells: 1, cleared_cells: 0 })
    await app.close()
  })

  it('代替候補が無ければ booth_id=NULL にして cleared_cells に計上する', async () => {
    const log: string[] = []
    const app = await buildTestApp(
      makeDb(log, {
        targets: [{ id: 'cell-1', card_id: 'card-1' }],
        fallbackCandidates: [],
        updateAffected: 1,
      }),
    )
    const res = await post(app, { booth_id: FROM_BOOTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ affected_cards: 1, reassigned_cells: 0, cleared_cells: 1 })
    await app.close()
  })

  it('競合で UPDATE が0件（既に達成済みになった等）ならカウントされない', async () => {
    const log: string[] = []
    const app = await buildTestApp(
      makeDb(log, {
        targets: [{ id: 'cell-1', card_id: 'card-1' }],
        fallbackCandidates: [{ id: REPLACEMENT_BOOTH, visitors: 0 }],
        updateAffected: 0,
      }),
    )
    const res = await post(app, { booth_id: FROM_BOOTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ affected_cards: 0, reassigned_cells: 0, cleared_cells: 0 })
    await app.close()
  })
})
