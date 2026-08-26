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
const BOOTH_ID = '33333333-3333-4333-8333-333333333333'
const CARD_ID = '44444444-4444-4444-8444-444444444444'

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
} as AppConfig

type Emitted = { room: string; event: string; payload: unknown }

/**
 * 中央3マス達成済み・残り1マス（position 10）が booth_id IS NULL のカードで
 * 最後のチェックインを行い、解放（processCenterAchievement）まで到達する経路を通す DB モック。
 * 外周12マスは既に is_revealed=1・is_achieved=0（フォールバック割当済み）とし、
 * assignOuterCellsForPairs は動かさず、代わりに `card_unlock_events` が既存の6ペア分あるとして
 * processCenterAchievement 側の新規ペア計算だけを走らせる。
 */
function makeDb(): DbClient {
  let centerFilled = false
  const unlockEvents: { id: string; card_id: string; pair_key: string }[] = []

  const run = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/SELECT role, email_verified_at FROM users/.test(sql)) {
      return [[{ role: 'participant', email_verified_at: '2026-08-01 00:00:00' }], undefined]
    }
    if (/SELECT id, name FROM booths WHERE id = \?/.test(sql)) {
      return [[{ id: BOOTH_ID, name: 'テストブース' }], undefined]
    }
    if (/SELECT id FROM bingo_cards WHERE event_id = \? AND user_id = \?/.test(sql)) {
      return [[{ id: CARD_ID }], undefined]
    }
    if (/SELECT COUNT\(\*\) AS c FROM bingo_cells WHERE card_id = \?$/.test(sql.trim())) {
      return [[{ c: 16 }], undefined]
    }
    if (/SELECT id FROM check_ins WHERE user_id = \? AND booth_id = \?/.test(sql)) {
      return [[], undefined]
    }
    if (/COALESCE\(MAX\(visit_order\),0\)/.test(sql)) {
      return [[{ m: 2 }], undefined]
    }
    if (/SELECT position FROM bingo_cells WHERE card_id = \? AND is_achieved = 1/.test(sql)) {
      const rows = centerFilled
        ? [{ position: 5 }, { position: 6 }, { position: 9 }, { position: 10 }]
        : [{ position: 5 }, { position: 6 }, { position: 9 }]
      return [rows, undefined]
    }
    if (/INSERT INTO check_ins/.test(sql)) {
      return [{ affectedRows: 1 }, undefined]
    }
    if (/SELECT id, position, zone FROM bingo_cells\s+WHERE card_id = \? AND booth_id = \? AND is_revealed = 1 AND is_achieved = 0/.test(sql)) {
      return [[], undefined]
    }
    if (/SELECT id, position FROM bingo_cells\s+WHERE card_id = \? AND zone = 'CENTER' AND booth_id IS NULL/.test(sql)) {
      return [centerFilled ? [] : [{ id: 'cell-10', position: 10 }], undefined]
    }
    if (/UPDATE bingo_cells\s+SET booth_id = \?, is_revealed = 1, is_achieved = 1,/.test(sql)) {
      const ok = !centerFilled
      centerFilled = true
      return [{ affectedRows: ok ? 1 : 0 }, undefined]
    }
    if (/UPDATE check_ins SET cell_id/.test(sql)) {
      return [{ affectedRows: 1 }, undefined]
    }
    // processCenterAchievement 内部（unlock.ts）
    if (/SELECT position FROM bingo_cells WHERE card_id = \? AND zone = 'CENTER' AND is_achieved = 1/.test(sql)) {
      return [[{ position: 5 }, { position: 6 }, { position: 9 }, { position: 10 }], undefined]
    }
    if (/SELECT pair_key FROM card_unlock_events WHERE card_id = \? AND pair_key <> 'PRESURVEY'/.test(sql)) {
      return [unlockEvents.map((e) => ({ pair_key: e.pair_key })), undefined]
    }
    if (/SELECT COUNT\(\*\) AS c FROM check_ins ci\s+JOIN users u/.test(sql)) {
      return [[{ c: 10 }], undefined]
    }
    if (/SELECT id FROM card_unlock_events WHERE card_id = \? AND pair_key = \? LIMIT 1/.test(sql)) {
      const [cardId, pairKey] = params as [string, string]
      const row = unlockEvents.find((e) => e.card_id === cardId && e.pair_key === pairKey)
      return [row ? [{ id: row.id }] : [], undefined]
    }
    if (/INSERT INTO card_unlock_events/.test(sql)) {
      const [id, cardId, pairKey] = params as [string, string, string]
      unlockEvents.push({ id, card_id: cardId, pair_key: pairKey })
      return [{ affectedRows: 1 }, undefined]
    }
    if (/SELECT id, position FROM bingo_cells WHERE card_id = \? AND zone = 'OUTER'/.test(sql)) {
      // 外周は 5,6,9,10（中央）を除く12マス
      return [
        [0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 15].map((position) => ({ id: `outer-${position}`, position })),
        undefined,
      ]
    }
    // buildExcludeSet は UNION 1本にまとまっている（C-4）
    if (/SELECT booth_id FROM bingo_cells WHERE card_id = \? AND booth_id IS NOT NULL\s+UNION/.test(sql)) {
      return [[], undefined]
    }
    if (/SELECT DISTINCT unlock_event_id FROM recommendation_scores/.test(sql)) {
      return [[], undefined]
    }
    if (/SELECT ci\.booth_id, ci\.visit_order, bc\.source, br\.rating/.test(sql)) {
      return [[], undefined]
    }
    if (/SELECT age_range, occupation, industry, custom_answers/.test(sql)) {
      return [[], undefined]
    }
    if (/SELECT b\.id, b\.category_id,[\s\S]*FROM booths b/.test(sql)) {
      return [[], undefined]
    }
    if (/SELECT b\.id, COUNT\(u\.id\) AS visitors\s+FROM booths b/.test(sql)) {
      return [Array.from({ length: 12 }, (_, i) => ({ id: `fallback-${i}`, visitors: 0 })), undefined]
    }
    if (/UPDATE bingo_cells\s+SET booth_id = CASE id/.test(sql)) {
      return [{ affectedRows: 6 }, undefined]
    }
    if (/INSERT INTO recommendation_scores/.test(sql)) {
      return [{ affectedRows: 1 }, undefined]
    }
    if (/UPDATE card_unlock_events\s+SET phase = \?/.test(sql)) {
      return [{ affectedRows: 1 }, undefined]
    }
    if (/LEFT JOIN booth_ratings r ON r\.checkin_id/.test(sql)) {
      return [[], undefined]
    }
    throw new Error(`unmatched SQL: ${sql} / ${JSON.stringify(params)}`)
  }
  return { query: run, execute: run, end: async () => {} }
}

function makeIo(emitted: Emitted[]) {
  return {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ room, event, payload })
      },
    }),
  } as unknown as Server
}

function authHeader(): Record<string, string> {
  const token = jwt.sign(
    { sub: USER_ID, event_id: EVENT_ID, display_name: 'テスト太郎', role: 'participant' },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function buildTestApp(db: DbClient, io: Server): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  app.decorate('io', io)
  await app.register(async (v1) => {
    await v1.register(checkinRoutes)
  }, { prefix: '/api/v1' })
  await app.ready()
  return app
}

describe('POST /events/:event_id/checkins（解放到達）', () => {
  it('中央4マス目のチェックインで unlocked_positions を返し、bingo:unlocked を1回だけ送出する', async () => {
    const emitted: Emitted[] = []
    const app = await buildTestApp(makeDb(), makeIo(emitted))
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins`,
      headers: authHeader(),
      payload: { method: 'qr', booth_id: BOOTH_ID, checked_in_at: new Date().toISOString() },
    })

    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.filled_cell).toEqual({ position: 10 })
    expect(data.unlocked_positions.length).toBeGreaterThan(0)
    // unlocked_pairs（ペア単位の内訳）。unlocked_positions は残したまま追加する
    expect(Array.isArray(data.unlocked_pairs)).toBe(true)
    expect(data.unlocked_pairs.length).toBeGreaterThan(0)
    for (const pair of data.unlocked_pairs as { pair_key: string; released_positions: number[] }[]) {
      expect(pair.pair_key).toMatch(/^\d+-\d+$/)
      expect(pair.released_positions.length).toBeGreaterThan(0)
      for (const pos of pair.released_positions) expect(data.unlocked_positions).toContain(pos)
    }
    // 平坦な配列と内訳の合計が一致する（フロントが対応表を複製せずに済む）
    const flattened = (data.unlocked_pairs as { released_positions: number[] }[]).flatMap((p) => p.released_positions)
    expect([...flattened].sort((a, b) => a - b)).toEqual([...data.unlocked_positions].sort((a: number, b: number) => a - b))
    expect(data.unlocked).toBeUndefined()
    expect(data.coins_earned).toBeUndefined()

    const unlockEvents = emitted.filter((e) => e.event === 'bingo:unlocked')
    expect(unlockEvents).toHaveLength(1)
    expect(unlockEvents[0]!.room).toBe(`event:${EVENT_ID}:user:${USER_ID}`)
    await app.close()
  })

  it('bingo:unlocked の unlocked_at が有効な ISO8601（Z 一つ）である', async () => {
    const emitted: Emitted[] = []
    const app = await buildTestApp(makeDb(), makeIo(emitted))
    await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins`,
      headers: authHeader(),
      payload: { method: 'qr', booth_id: BOOTH_ID, checked_in_at: new Date().toISOString() },
    })

    const payload = emitted.find((e) => e.event === 'bingo:unlocked')!.payload as {
      unlock_event_ids: string[]
      released_positions: number[]
      unlocked_pairs: { pair_key: string; released_positions: number[] }[]
      unlocked_at: string
    }
    expect(Array.isArray(payload.unlock_event_ids)).toBe(true)
    expect(payload.released_positions.length).toBeGreaterThan(0)
    // socket.io の bingo:unlocked にも同じ unlocked_pairs を載せる
    expect(payload.unlocked_pairs.length).toBeGreaterThan(0)
    expect(payload.unlocked_pairs.every((p) => typeof p.pair_key === 'string')).toBe(true)
    expect(payload.unlocked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(Number.isNaN(new Date(payload.unlocked_at).getTime())).toBe(false)
    await app.close()
  })
})
