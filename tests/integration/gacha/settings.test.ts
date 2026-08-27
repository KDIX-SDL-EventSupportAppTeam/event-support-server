/**
 * 対象: src/routes/v1/organizer/gacha-settings.ts, src/routes/v1/admin/gacha.ts
 * 仕様: docs/specs/gacha-and-award/04-api/organizer-api.md
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
  makePool,
  organizerToken,
  participantToken,
  seedFixture,
  seedLines,
  staffToken,
  useCoinReq,
} from './helpers.js'

let db: DbClient
let app: FastifyInstance
const created: { eventId: string; organizerId: string }[] = []

beforeAll(async () => {
  db = makePool()
  await assertDbReachable(db)
  app = await buildGachaApp(db)
})

afterEach(async () => {
  while (created.length) {
    const e = created.pop()!
    await cleanupEvent(db, e.eventId, e.organizerId)
  }
})

afterAll(async () => {
  await app?.close()
  await db?.end()
})

async function fx() {
  const f = await seedFixture(db, {})
  created.push({ eventId: f.eventId, organizerId: f.organizerId })
  return f
}

function putSettings(
  eventId: string,
  token: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/organizer/events/${eventId}/gacha/settings`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  })
}

describe('GET/PUT /organizer/events/:event_id/gacha/settings', () => {
  it('organizer 以外の権限では PUT が 401/403', async () => {
    const f = await fx()
    const asParticipant = await putSettings(f.eventId, f.token, {
      is_enabled: true,
      coins_per_line: 1,
      max_coins: 4,
      bonus_coins: 0,
    })
    expect([401, 403]).toContain(asParticipant.statusCode)
  })

  it('別 organizer では 403（所有チェック）', async () => {
    const f = await fx()
    const other = await putSettings(f.eventId, organizerToken(randomUUID()), {
      is_enabled: true,
      coins_per_line: 1,
      max_coins: 4,
      bonus_coins: 0,
    })
    expect(other.statusCode).toBe(403)
  })

  it('範囲外の値で 400（max_coins=-1 / coins_per_line=11 / bonus_coins=11）', async () => {
    const f = await fx()
    const t = organizerToken(f.organizerId)
    for (const bad of [
      { is_enabled: true, coins_per_line: 1, max_coins: -1, bonus_coins: 0 },
      { is_enabled: true, coins_per_line: 11, max_coins: 4, bonus_coins: 0 },
      { is_enabled: true, coins_per_line: 1, max_coins: 51, bonus_coins: 0 },
      { is_enabled: true, coins_per_line: 1, max_coins: 4, bonus_coins: 11 },
      { is_enabled: true, coins_per_line: 1.5, max_coins: 4, bonus_coins: 0 },
      { coins_per_line: 1, max_coins: 4, bonus_coins: 0 }, // is_enabled 欠落
    ]) {
      const res = await putSettings(f.eventId, t, bad)
      expect(res.statusCode).toBe(400)
    }
  })

  it('行が無い状態への PUT が INSERT として成立し、GET で読み戻せる', async () => {
    const f = await fx()
    // seedFixture が入れた行を消して「行なし」状態にする
    await db.execute(`DELETE FROM gacha_settings WHERE event_id = ?`, [f.eventId])
    const t = organizerToken(f.organizerId)

    const put = await putSettings(f.eventId, t, {
      is_enabled: true,
      coins_per_line: 2,
      max_coins: 8,
      bonus_coins: 1,
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().data).toEqual({
      is_enabled: true,
      coins_per_line: 2,
      max_coins: 8,
      bonus_coins: 1,
    })

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/organizer/events/${f.eventId}/gacha/settings`,
      headers: { authorization: `Bearer ${t}` },
    })
    expect(get.json().data).toEqual({
      is_enabled: true,
      coins_per_line: 2,
      max_coins: 8,
      bonus_coins: 1,
    })
  })

  it('変更が audit_logs に1行残る（変更前後の値つき）', async () => {
    const f = await fx()
    const t = organizerToken(f.organizerId)
    await putSettings(f.eventId, t, {
      is_enabled: true,
      coins_per_line: 1,
      max_coins: 3,
      bonus_coins: 0,
    })
    const [rows] = await db.query(
      `SELECT action, target_type, detail FROM audit_logs WHERE event_id = ? AND target_type = 'gacha_settings'`,
      [f.eventId],
    )
    const list = rows as { action: string; target_type: string; detail: unknown }[]
    expect(list).toHaveLength(1)
    // JSON カラムはドライバがパース済みで返すことがある
    const detail =
      typeof list[0].detail === 'string'
        ? JSON.parse(list[0].detail)
        : (list[0].detail as { before: { max_coins: number }; after: { max_coins: number } })
    expect(detail.before.max_coins).toBe(4) // seedFixture の既定
    expect(detail.after.max_coins).toBe(3)
  })
})

describe('GET /admin/events/:event_id/gacha/stats', () => {
  it('total_used が台帳の行数と一致し、used_by_hour の合計と一致する', async () => {
    const f = await seedFixture(db, { userCount: 3 })
    created.push({ eventId: f.eventId, organizerId: f.organizerId })
    for (const uid of f.userIds) await seedLines(db, f.eventId, uid, 3)

    // 3 ユーザー合計 5 枚消費
    const plan: [string, number][] = [
      [f.userIds[0], 3],
      [f.userIds[1], 2],
      [f.userIds[2], 0],
    ]
    for (const [uid, n] of plan) {
      const t = participantToken(uid, f.eventId)
      for (let i = 0; i < n; i++) {
        const r = await useCoinReq(app, f.eventId, t, randomUUID())
        expect(r.statusCode).toBe(200)
      }
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${f.eventId}/gacha/stats`,
      headers: { authorization: `Bearer ${staffToken(f.eventId, 'manager')}` },
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.total_used).toBe(5)
    expect(data.users_who_used).toBe(2)
    expect(data.users_with_coins).toBe(3) // 3 人とも earned=3 > 0
    const hourSum = data.used_by_hour.reduce(
      (acc: number, h: { count: number }) => acc + h.count,
      0,
    )
    expect(hourSum).toBe(5)
  })

  it('参加者トークンでは stats にアクセスできない', async () => {
    const f = await fx()
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/events/${f.eventId}/gacha/stats`,
      headers: { authorization: `Bearer ${f.token}` },
    })
    expect([401, 403]).toContain(res.statusCode)
  })
})
