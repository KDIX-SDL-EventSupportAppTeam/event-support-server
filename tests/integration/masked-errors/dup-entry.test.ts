/**
 * 対象: src/lib/bingo/unlock.ts（tryClaimPair）, src/routes/v1/checkins.ts（チェックイン / 評価）
 * 仕様: ADR 0001（本番プロキシはエラーコードを消して 500 にする）/ issue #173
 *
 * ローカル MySQL（docker compose）に対して実行する。DbClient を包み、エラーを
 * 「コードの無い汎用 Error」に作り替える（= 本番プロキシの挙動）。さらに事前 SELECT を
 * 同時に通過させて、INSERT が確実に競合する状況を作る。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Server } from 'socket.io'
import type { DbClient } from '../../../src/db/client.js'
import { checkinRoutes } from '../../../src/routes/v1/checkins.js'
import { ensureCard } from '../../../src/lib/bingo/ensureCard.js'
import { tryClaimPair } from '../../../src/lib/bingo/unlock.js'
import { pairDefinitionByKey } from '../../../src/lib/bingo/unlockPairs.js'
import {
  assertDbReachable,
  cleanupEvent,
  config,
  makePool,
  participantToken,
  seedFixture,
} from '../gacha/helpers.js'

let rawDb: DbClient
const created: { eventId: string; organizerId: string }[] = []

/**
 * 本番プロキシ相当: 失敗は常に「コード無しの Error」。
 * gate に一致する SELECT の最初の n 回は、n 本が揃うまで結果を返さない
 * （全員が「まだ無い」を見てから INSERT に進むようにする）。
 */
function maskedDb(gate?: { pattern: RegExp; n: number }): DbClient {
  let arrived = 0
  let release!: () => void
  const allArrived = new Promise<void>((r) => (release = r))
  const mask = async (p: Promise<[unknown, unknown]>): Promise<[unknown, unknown]> => {
    try {
      return await p
    } catch {
      throw new Error('Internal Server Error')
    }
  }
  const maybeGate = async (sql: string) => {
    if (!gate || !gate.pattern.test(sql) || arrived >= gate.n) return
    arrived++
    if (arrived === gate.n) release()
    await allArrived
  }
  return {
    query: async (sql, params) => {
      const r = await mask(rawDb.query(sql, params))
      await maybeGate(sql)
      return r
    },
    execute: (sql, params) => mask(rawDb.execute(sql, params)),
    end: async () => {},
  }
}

beforeAll(async () => {
  rawDb = makePool()
  await assertDbReachable(rawDb)
})

afterEach(async () => {
  while (created.length) {
    const e = created.pop()!
    await cleanupEvent(rawDb, e.eventId, e.organizerId)
  }
})

afterAll(async () => {
  await rawDb?.end()
})

async function eventFixture() {
  const f = await seedFixture(rawDb)
  created.push({ eventId: f.eventId, organizerId: f.organizerId })
  return f
}

async function insertBooth(eventId: string): Promise<string> {
  const id = randomUUID()
  await rawDb.execute(
    `INSERT INTO booths (id, event_id, name, manual_code, qr_token) VALUES (?,?,?,?,?)`,
    [id, eventId, 'ブース', '123456', randomUUID().replace(/-/g, '').slice(0, 10)],
  )
  return id
}

async function buildApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  app.decorate('io', { to: () => ({ emit: () => {} }) } as unknown as Server)
  await app.register(checkinRoutes, { prefix: '/api/v1' })
  await app.ready()
  return app
}

describe('#173 card_unlock_events の同時確保（tryClaimPair）', () => {
  it('エラーコードが消えても、勝者は id・敗者は null。例外にならず行は1件', async () => {
    const f = await eventFixture()
    const card = await ensureCard(rawDb, f.eventId, f.userId)
    const pair = pairDefinitionByKey('5-6')!
    const db = maskedDb({ pattern: /FROM card_unlock_events WHERE card_id = \? AND pair_key = \?/, n: 2 })

    const results = await Promise.allSettled([
      tryClaimPair(db, card.id, pair, 0),
      tryClaimPair(db, card.id, pair, 0),
    ])

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    const values = results.map((r) => (r as PromiseFulfilledResult<string | null>).value)
    expect(values.filter((v) => v !== null)).toHaveLength(1)
    expect(values.filter((v) => v === null)).toHaveLength(1)

    const [rows] = await rawDb.query(
      `SELECT id FROM card_unlock_events WHERE card_id = ? AND pair_key = ?`,
      [card.id, '5-6'],
    )
    expect(rows as unknown[]).toHaveLength(1)
  })

  it('重複とは無関係の失敗（行が無いまま INSERT が落ちる）は握りつぶさず再 throw する', async () => {
    const pair = pairDefinitionByKey('5-6')!
    // 存在しない card_id → FK 違反（行は作られない）
    await expect(tryClaimPair(maskedDb(), randomUUID(), pair, 0)).rejects.toThrow()
  })
})

describe('#173 同ブースへの同時チェックイン（POST /checkins）', () => {
  it('エラーコードが消えても 200 と 409 になり、500 は出ない。check_ins は1件', async () => {
    const f = await eventFixture()
    const boothId = await insertBooth(f.eventId)
    await ensureCard(rawDb, f.eventId, f.userId)
    const app = await buildApp(maskedDb({ pattern: /FROM check_ins WHERE user_id = \? AND booth_id = \?/, n: 2 }))

    const post = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/events/${f.eventId}/checkins`,
        headers: { authorization: `Bearer ${participantToken(f.userId, f.eventId)}` },
        payload: { method: 'qr', booth_id: boothId, checked_in_at: new Date().toISOString() },
      })
    const res = await Promise.all([post(), post()])
    await app.close()

    expect(res.some((r) => r.statusCode === 500)).toBe(false)
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect(res.find((r) => r.statusCode === 409)!.json().error.code).toBe('CONFLICT')

    const [rows] = await rawDb.query(`SELECT id FROM check_ins WHERE user_id = ? AND booth_id = ?`, [
      f.userId,
      boothId,
    ])
    expect(rows as unknown[]).toHaveLength(1)
  })
})

describe('#173 同じチェックインへの同時評価（POST /checkins/:id/rating）', () => {
  it('エラーコードが消えても 200 と 409 になり、500 は出ない。booth_ratings は1件', async () => {
    const f = await eventFixture()
    const boothId = await insertBooth(f.eventId)
    await ensureCard(rawDb, f.eventId, f.userId)
    const checkinId = randomUUID()
    await rawDb.execute(
      `INSERT INTO check_ins (id, user_id, booth_id, event_id, checkin_method, checked_in_at, visit_order)
       VALUES (?,?,?,?, 'qr', '2026-10-16 01:00:00', 1)`,
      [checkinId, f.userId, boothId, f.eventId],
    )
    const app = await buildApp(maskedDb({ pattern: /FROM booth_ratings WHERE checkin_id = \?/, n: 2 }))

    const post = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/events/${f.eventId}/checkins/${checkinId}/rating`,
        headers: { authorization: `Bearer ${participantToken(f.userId, f.eventId)}` },
        payload: { rating: 3 },
      })
    const res = await Promise.all([post(), post()])
    await app.close()

    expect(res.some((r) => r.statusCode === 500)).toBe(false)
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409])
    const [rows] = await rawDb.query(`SELECT id FROM booth_ratings WHERE checkin_id = ?`, [checkinId])
    expect(rows as unknown[]).toHaveLength(1)
  })
})
