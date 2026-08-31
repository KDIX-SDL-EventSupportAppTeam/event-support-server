/**
 * 対象: src/routes/v1/gacha.ts, src/lib/gacha/useCoin.ts
 * 仕様: docs/specs/gacha-and-award/10-testing/concurrency.md（C-1 〜 C-10 と「起きてはいけないこと」）
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
  dumpUses,
  getCoinsReq,
  makePool,
  participantToken,
  seedFixture,
  seedLines,
  setSettings,
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

describe('GET /gacha/coins（副作用なし・堅牢性）', () => {
  it('gacha_settings の行が無いイベントでも 200（コード側の既定値）', async () => {
    const f = await fixture(2)
    await db.execute(`DELETE FROM gacha_settings WHERE event_id = ?`, [f.eventId])
    const res = await getCoinsReq(app, f.eventId, f.token)
    expect(res.statusCode).toBe(200)
    expect(res.body.data!.is_enabled).toBe(false)
    expect(res.body.data!.max_coins).toBe(4)
  })

  // コイン枚数の問い合わせはビンゴカードを作らない。作っていた頃は、ホーム初回表示で
  // GET /bingo/card と同時に走って ensureCard が競合し、片方が 500 になっていた
  it('カード未発行のユーザーが GET してもエラーにならず、カードを作らない', async () => {
    const f = await seedFixture(db, {})
    createdEvents.push({ eventId: f.eventId, organizerId: f.organizerId })
    // seedLines を呼ばない = bingo_cards / bingo_cells は未作成
    const res = await getCoinsReq(app, f.eventId, f.token)
    expect(res.statusCode).toBe(200)
    expect(res.body.data!.lines_completed).toBe(0)
    expect(res.body.data!.earned).toBe(0)
    const [cards] = await db.query(
      `SELECT id FROM bingo_cards WHERE event_id = ? AND user_id = ?`,
      [f.eventId, f.userId],
    )
    expect((cards as unknown[]).length).toBe(0)
  })

  it('POST 成功後の GET の used が POST 応答の used と一致する', async () => {
    const f = await fixture(3)
    const post = await useCoinReq(app, f.eventId, f.token, randomUUID())
    const get = await getCoinsReq(app, f.eventId, f.token)
    expect(get.body.data!.used).toBe(post.body.data!.used)
  })
})

describe('C-1. 同じ冪等キーの並行2回', () => {
  it('行1件・枚数1枚。両応答は同じ coin_index / used / used_at で 200', async () => {
    const f = await fixture(3)
    const key = randomUUID()
    const [a, b] = await Promise.all([
      useCoinReq(app, f.eventId, f.token, key),
      useCoinReq(app, f.eventId, f.token, key),
    ])
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    expect(a.body.data!.coin_index).toBe(b.body.data!.coin_index)
    expect(a.body.data!.used).toBe(b.body.data!.used)
    expect(a.body.data!.used_at).toBe(b.body.data!.used_at)

    const rows = await dumpUses(db, f.eventId, f.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].coin_index).toBe(0)
  })
})

describe('C-2. 同じ冪等キーの逐次2回（リトライ相当）', () => {
  it('2回目も 200。行は1行のまま used は増えない', async () => {
    const f = await fixture(3)
    const key = randomUUID()
    const first = await useCoinReq(app, f.eventId, f.token, key)
    const second = await useCoinReq(app, f.eventId, f.token, key)
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.body.data!.used).toBe(first.body.data!.used)
    expect(second.body.data!.coin_index).toBe(first.body.data!.coin_index)
    expect(await dumpUses(db, f.eventId, f.userId)).toHaveLength(1)
  })
})

describe('C-3. 別キーの並行2回・残高1枚', () => {
  it('成功ちょうど1本、もう1本は 409。行1件・coin_index=0・500 が返らない', async () => {
    const f = await fixture(1)
    const results = await Promise.all([
      useCoinReq(app, f.eventId, f.token, randomUUID()),
      useCoinReq(app, f.eventId, f.token, randomUUID()),
    ])
    const ok = results.filter((r) => r.statusCode === 200)
    const conflict = results.filter((r) => r.statusCode === 409)
    expect(ok).toHaveLength(1)
    expect(conflict).toHaveLength(1)
    expect(conflict[0].body.error!.code).toBe('NO_COINS_AVAILABLE')
    expect(results.some((r) => r.statusCode === 500)).toBe(false)

    const rows = await dumpUses(db, f.eventId, f.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].coin_index).toBe(0)
  })
})

describe('C-4. 別キーの並行5回・残高3枚', () => {
  it('成功ちょうど3本・409 が2本。coin_index は 0,1,2 で重複も欠番も無い', async () => {
    const f = await fixture(3)
    const results = await Promise.all(
      Array.from({ length: 5 }, () => useCoinReq(app, f.eventId, f.token, randomUUID())),
    )
    const ok = results.filter((r) => r.statusCode === 200)
    const conflict = results.filter((r) => r.statusCode === 409)
    expect(results.some((r) => r.statusCode === 500)).toBe(false)
    expect(ok).toHaveLength(3)
    expect(conflict).toHaveLength(2)

    const rows = await dumpUses(db, f.eventId, f.userId)
    expect(rows.map((r) => r.coin_index).sort((x, y) => x - y)).toEqual([0, 1, 2])

    const after = await getCoinsReq(app, f.eventId, f.token)
    expect(after.body.data!.used).toBe(3)
    expect(after.body.data!.available).toBe(0)
  })
})

describe('C-5. 残高ゼロ', () => {
  it('earned=0 で 409、行は0のまま', async () => {
    const f = await fixture(0)
    const res = await useCoinReq(app, f.eventId, f.token, randomUUID())
    expect(res.statusCode).toBe(409)
    expect(await dumpUses(db, f.eventId, f.userId)).toHaveLength(0)
  })

  it('earned=used の状態で 409', async () => {
    const f = await fixture(1)
    expect((await useCoinReq(app, f.eventId, f.token, randomUUID())).statusCode).toBe(200)
    const res = await useCoinReq(app, f.eventId, f.token, randomUUID())
    expect(res.statusCode).toBe(409)
    expect(await dumpUses(db, f.eventId, f.userId)).toHaveLength(1)
  })
})

describe('C-6. 消費中にライン数が増える', () => {
  it('直前に増やす: used <= earned が保たれる', async () => {
    const f = await fixture(1)
    await seedLines(db, f.eventId, f.userId, 3)
    const res = await useCoinReq(app, f.eventId, f.token, randomUUID())
    expect(res.statusCode).toBe(200)
    expect(res.body.data!.used).toBeLessThanOrEqual(res.body.data!.earned)
  })

  it('直後に増やす: 古い earned を読んでいても過剰消費にならない', async () => {
    const f = await fixture(1)
    const res = await useCoinReq(app, f.eventId, f.token, randomUUID())
    await seedLines(db, f.eventId, f.userId, 4)
    expect(res.statusCode).toBe(200)
    const rows = await dumpUses(db, f.eventId, f.userId)
    expect(rows).toHaveLength(1)
    const after = await getCoinsReq(app, f.eventId, f.token)
    expect(after.body.data!.used).toBeLessThanOrEqual(after.body.data!.earned)
  })
})

describe('C-7. 別ユーザー・別イベントの独立', () => {
  it('ユーザーA の消費がユーザーB の available に影響しない', async () => {
    const f = await fixture(2, 2)
    const [a, b] = f.userIds
    const tokenA = participantToken(a, f.eventId)
    const tokenB = participantToken(b, f.eventId)
    await useCoinReq(app, f.eventId, tokenA, randomUUID())
    const bState = await getCoinsReq(app, f.eventId, tokenB)
    expect(bState.body.data!.used).toBe(0)
    expect(bState.body.data!.available).toBe(2)
  })

  it('イベントが違えば coin_index は 0 から始まる別系列。同じ冪等キーを別イベントで使っても両方成立する', async () => {
    // users.id はグローバル一意（PK）のためイベントごとに別ユーザー行になる。
    // 検証したいのは gacha_coin_uses のキーが (event_id, user_id, ...) で独立していること。
    const f1 = await fixture(2)
    const f2 = await seedFixture(db, {})
    createdEvents.push({ eventId: f2.eventId, organizerId: f2.organizerId })
    await seedLines(db, f2.eventId, f2.userId, 2)

    const key = randomUUID()
    const r1 = await useCoinReq(app, f1.eventId, f1.token, key)
    const r2 = await useCoinReq(app, f2.eventId, f2.token, key)
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(r1.body.data!.coin_index).toBe(0)
    expect(r2.body.data!.coin_index).toBe(0)
  })
})

describe('C-8. 無効化', () => {
  it('is_enabled=0 で使用が 403、行は増えない。GET は 200', async () => {
    const f = await fixture(3)
    await setSettings(db, f.eventId, {
      is_enabled: 0,
      coins_per_line: 1,
      max_coins: 4,
      bonus_coins: 0,
    })
    const use = await useCoinReq(app, f.eventId, f.token, randomUUID())
    expect(use.statusCode).toBe(403)
    expect(use.body.error!.code).toBe('GACHA_DISABLED')
    expect(await dumpUses(db, f.eventId, f.userId)).toHaveLength(0)

    const get = await getCoinsReq(app, f.eventId, f.token)
    expect(get.statusCode).toBe(200)
    expect(get.body.data!.is_enabled).toBe(false)
  })

  it('消費の後に無効化しても、成立済みの行は消えない', async () => {
    const f = await fixture(3)
    await useCoinReq(app, f.eventId, f.token, randomUUID())
    await setSettings(db, f.eventId, {
      is_enabled: 0,
      coins_per_line: 1,
      max_coins: 4,
      bonus_coins: 0,
    })
    expect(await dumpUses(db, f.eventId, f.userId)).toHaveLength(1)
  })
})

describe('C-9. 設定変更との組み合わせ', () => {
  it('max_coins を下げて used > earned になっても available=0 で 200、次の使用は 409', async () => {
    const f = await fixture(4) // earned=4
    for (let i = 0; i < 3; i++) {
      expect((await useCoinReq(app, f.eventId, f.token, randomUUID())).statusCode).toBe(200)
    }
    await setSettings(db, f.eventId, {
      is_enabled: 1,
      coins_per_line: 1,
      max_coins: 1,
      bonus_coins: 0,
    })
    const get = await getCoinsReq(app, f.eventId, f.token)
    expect(get.statusCode).toBe(200)
    expect(get.body.data!.available).toBe(0)

    const use = await useCoinReq(app, f.eventId, f.token, randomUUID())
    expect(use.statusCode).toBe(409)
  })

  it('bonus_coins を +1 するとその場で available が1増える', async () => {
    const f = await fixture(2) // earned=2
    const before = await getCoinsReq(app, f.eventId, f.token)
    expect(before.body.data!.available).toBe(2)
    await setSettings(db, f.eventId, {
      is_enabled: 1,
      coins_per_line: 1,
      max_coins: 4,
      bonus_coins: 1,
    })
    const after = await getCoinsReq(app, f.eventId, f.token)
    expect(after.body.data!.available).toBe(3)
    expect(after.body.data!.earned).toBe(3)
  })
})

describe('C-10. 入力', () => {
  it('idempotency_key 欠落で 400、行は増えない', async () => {
    const f = await fixture(3)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${f.eventId}/gacha/coins/use`,
      headers: { authorization: `Bearer ${f.token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('INVALID_BODY')
    expect(await dumpUses(db, f.eventId, f.userId)).toHaveLength(0)
  })

  it('UUID 形式でない文字列で 400', async () => {
    const f = await fixture(3)
    const res = await useCoinReq(app, f.eventId, f.token, 'not-a-uuid')
    expect(res.statusCode).toBe(400)
    expect(res.body.error!.code).toBe('INVALID_BODY')
  })

  it('他イベントの event_id を指定すると requireEventMatchesJwt で 403', async () => {
    const f = await fixture(3)
    const otherEventId = randomUUID()
    const res = await useCoinReq(app, otherEventId, f.token, randomUUID())
    expect(res.statusCode).toBe(403)
  })

  it('未認証で 401', async () => {
    const f = await fixture(3)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${f.eventId}/gacha/coins/use`,
      payload: { idempotency_key: randomUUID() },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('起きてはいけないこと', () => {
  it('連打・並行・リトライを混ぜても used > earned の行が生まれない', async () => {
    const f = await fixture(3)
    const key = randomUUID()
    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 4; i++) ops.push(useCoinReq(app, f.eventId, f.token, randomUUID()))
    ops.push(useCoinReq(app, f.eventId, f.token, key))
    ops.push(useCoinReq(app, f.eventId, f.token, key))
    await Promise.all(ops)

    const rows = await dumpUses(db, f.eventId, f.userId)
    expect(rows.length).toBeLessThanOrEqual(3) // earned=3
    // coin_index に重複が無い
    expect(new Set(rows.map((r) => r.coin_index)).size).toBe(rows.length)
    // 欠番が無い（0..n-1）
    expect(rows.map((r) => r.coin_index).sort((a, b) => a - b)).toEqual(
      rows.map((_, i) => i),
    )
  })

  it('台帳全体を走査しても coin_index が重複した行が存在しない', async () => {
    const f = await fixture(4, 3)
    await Promise.all(
      f.userIds.flatMap((uid) => {
        const t = participantToken(uid, f.eventId)
        return Array.from({ length: 6 }, () => useCoinReq(app, f.eventId, t, randomUUID()))
      }),
    )
    const rows = await dumpUses(db, f.eventId)
    const seen = new Set<string>()
    for (const r of rows) {
      const k = `${r.user_id}:${r.coin_index}`
      expect(seen.has(k)).toBe(false)
      seen.add(k)
    }
    // 各ユーザー高々4行（earned 上限4）
    for (const uid of f.userIds) {
      expect(rows.filter((r) => r.user_id === uid).length).toBeLessThanOrEqual(4)
    }
  })

  it('同一冪等キーの再送は socket を送らない（そもそも socket を扱わない）', async () => {
    // gachaRoutes は socket インスタンスを一切参照しない。
    // buildGachaApp は socket を登録していないため、消費が成功しても例外にならないことで確認する。
    const f = await fixture(2)
    const key = randomUUID()
    expect((await useCoinReq(app, f.eventId, f.token, key)).statusCode).toBe(200)
    expect((await useCoinReq(app, f.eventId, f.token, key)).statusCode).toBe(200)
  })
})
