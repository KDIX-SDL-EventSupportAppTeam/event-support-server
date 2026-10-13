/**
 * 対象: src/routes/v1/gacha.ts（GET /gacha/coins/history）, src/lib/gacha/useCoin.ts（used_at の UTC 明示）
 * 仕様: docs/specs/gacha-and-award/04-api/participant-api.md
 *
 * ローカル MySQL（docker compose の event-support-mysql）に対して実行する。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { DbClient } from '../../../src/db/client.js'
import {
  assertDbReachable,
  buildGachaApp,
  cleanupEvent,
  getCoinsReq,
  makePool,
  participantToken,
  seedFixture,
  seedLines,
  useCoinReq,
} from './helpers.js'

let db: DbClient
let app: FastifyInstance
const createdEvents: { eventId: string; organizerId: string }[] = []

beforeAll(async () => {
  db = makePool()
  await assertDbReachable(db)
  app = await buildGachaApp(db)
})

afterEach(async () => {
  while (createdEvents.length) {
    const e = createdEvents.pop()!
    await cleanupEvent(db, e.eventId, e.organizerId)
  }
})

afterAll(async () => {
  await app?.close()
  await db?.end()
})

async function fixture(lines: number, userCount = 1) {
  const f = await seedFixture(db, { userCount })
  createdEvents.push({ eventId: f.eventId, organizerId: f.organizerId })
  for (const uid of f.userIds) await seedLines(db, f.eventId, uid, lines)
  return f
}

async function historyReq(eventId: string, token: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/events/${eventId}/gacha/coins/history`,
    headers: { authorization: `Bearer ${token}` },
  })
  return { statusCode: res.statusCode, body: res.json() }
}

describe('GET /gacha/coins/history', () => {
  it('0 枚使用: uses は空で、集計値は GET /gacha/coins と一致する', async () => {
    const f = await fixture(3)
    const hist = await historyReq(f.eventId, f.token)
    const coins = await getCoinsReq(app, f.eventId, f.token)

    expect(hist.statusCode).toBe(200)
    expect(hist.body.data.uses).toEqual([])
    expect(hist.body.data.email).toMatch(/@example\.com$/)
    expect(hist.body.data.display_name).toBe('参加者0')
    const { email, display_name, uses, ...totals } = hist.body.data
    expect(totals).toEqual(coins.body.data)
  })

  it('複数枚使用後: uses の件数が used と一致し、coin_index 昇順', async () => {
    const f = await fixture(3)
    for (let i = 0; i < 2; i++) {
      expect((await useCoinReq(app, f.eventId, f.token, randomUUID())).statusCode).toBe(200)
    }
    const hist = await historyReq(f.eventId, f.token)
    expect(hist.body.data.used).toBe(2)
    expect(hist.body.data.uses).toHaveLength(hist.body.data.used)
    expect(hist.body.data.uses.map((u: { coin_index: number }) => u.coin_index)).toEqual([0, 1])
    expect(hist.body.data.available).toBe(1)
  })

  it('POST /use の used_at と履歴の used_at が同じ UTC 時刻になる', async () => {
    const f = await fixture(1)
    const before = Date.now()
    const use = await useCoinReq(app, f.eventId, f.token, randomUUID())
    const after = Date.now()
    const hist = await historyReq(f.eventId, f.token)

    expect(hist.body.data.uses[0].used_at).toBe(use.body.data!.used_at)
    // DB 既定値（JST）だと 9 時間ずれる。実時刻（UTC）との差は数秒以内（秒未満切り捨て分を見込む）
    const t = new Date(use.body.data!.used_at!).getTime()
    expect(t).toBeGreaterThanOrEqual(before - 2000)
    expect(t).toBeLessThanOrEqual(after + 2000)
  })

  it('他ユーザーの履歴は返らない（別ユーザーのトークンでは 0 件・自分の email）', async () => {
    const f = await fixture(3, 2)
    await useCoinReq(app, f.eventId, f.token, randomUUID())

    const otherToken = participantToken(f.userIds[1], f.eventId)
    const hist = await historyReq(f.eventId, otherToken)
    expect(hist.body.data.uses).toEqual([])
    expect(hist.body.data.used).toBe(0)
    expect(hist.body.data.email).toContain(f.userIds[1])
  })

  it('別イベントの event_id は 403、トークン無しは 401', async () => {
    const f = await fixture(1)
    const other = await fixture(1)
    const wrong = await historyReq(other.eventId, f.token)
    expect(wrong.statusCode).toBe(403)

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/events/${f.eventId}/gacha/coins/history`,
    })
    expect(res.statusCode).toBe(401)
  })
})
