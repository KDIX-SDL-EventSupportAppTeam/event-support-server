import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { bingoRoutes } from '../../src/routes/v1/bingo.js'
import { CENTER_POSITIONS } from '../../src/lib/bingo/unlockPairs.js'

/**
 * GET /bingo/card が終端状態のマス（issue #150）を区別して返すことを固定する。
 * docs/specs/bingo-dynamic-unlock/06-api/participant-api.md「終端状態のマス」
 *
 * フロント（event-support-frontend#152）はここに出る no_candidate_reason で
 * 「すべてのブースを訪問しました」と運営向けの異常を出し分ける。
 */

const JWT_SECRET = 'test-secret'
const EVENT_ID = '30000000-0000-4000-8000-000000000001'
const USER_ID = '30000000-0000-4000-8000-000000000002'
const CARD_ID = '30000000-0000-4000-8000-000000000003'

const config = {
  port: 3000,
  databaseUrl: 'mysql://test',
  sakuraProxyUrl: undefined,
  sakuraProxyKey: undefined,
  jwtSecret: JWT_SECRET,
  webhookApiKey: '',
  recommenderUrl: '',
  recommenderTimeoutMs: 1000,
  checkinCooldownSec: 0,
  ratingScale: 4,
  corsOrigin: 'http://localhost:5173',
  adminRegistrationKey: 'k',
  frontendBaseUrl: undefined,
  organizerRegistrationKey: undefined,
  organizerSignupMode: 'invite',
  smtpHost: undefined,
  smtpPort: 587,
  smtpUser: undefined,
  smtpPass: undefined,
  mailFrom: 'from@example.com',
} as AppConfig

type CellRow = {
  position: number
  zone: 'CENTER' | 'OUTER'
  is_revealed: number
  is_achieved: number
  source: string | null
  no_candidate_reason: string | null
  booth_id: string | null
  booth_name: string | null
  display_code: string | null
  booth_description: string | null
}

/**
 * 中央4マスは訪問済み、外周12マスのうち 0/1/4/7/13/15 は全制覇で終端状態、
 * 残り6マスは先の解放で埋まって訪問済み、というカードを返す。
 */
function buildCellRows(): CellRow[] {
  const allVisitedPositions = [0, 1, 4, 7, 13, 15]
  return Array.from({ length: 16 }, (_, position) => {
    const isCenter = CENTER_POSITIONS.includes(position)
    if (isCenter) {
      return {
        position,
        zone: 'CENTER' as const,
        is_revealed: 1,
        is_achieved: 1,
        source: 'FREE_VISIT',
        no_candidate_reason: null,
        booth_id: `booth-center-${position}`,
        booth_name: `中央ブース${position}`,
        display_code: 'A-1',
        booth_description: '説明',
      }
    }
    if (allVisitedPositions.includes(position)) {
      return {
        position,
        zone: 'OUTER' as const,
        is_revealed: 1,
        is_achieved: 1,
        source: 'NO_CANDIDATE',
        no_candidate_reason: 'ALL_VISITED',
        booth_id: null,
        booth_name: null,
        display_code: null,
        booth_description: null,
      }
    }
    return {
      position,
      zone: 'OUTER' as const,
      is_revealed: 1,
      is_achieved: 1,
      source: 'RECOMMEND',
      no_candidate_reason: null,
      booth_id: `booth-outer-${position}`,
      booth_name: `外周ブース${position}`,
      display_code: 'B-2',
      booth_description: '説明',
    }
  })
}

function makeDb(cellRows: CellRow[], log: string[]): DbClient {
  const run = async (sql: string, _params: unknown[] = []): Promise<[unknown, unknown]> => {
    log.push(sql)
    if (/SELECT id FROM bingo_cards WHERE event_id = \? AND user_id = \?/.test(sql)) {
      return [[{ id: CARD_ID }], undefined]
    }
    if (/SELECT COUNT\(\*\) AS c FROM bingo_cells WHERE card_id = \?/.test(sql)) {
      return [[{ c: 16 }], undefined]
    }
    // 自己修復の検知クエリ: 終端状態のマスは修復対象にならないので空で返る
    if (/FROM card_unlock_events cue[\s\S]*FIND_IN_SET/.test(sql)) {
      return [[], undefined]
    }
    if (/SELECT c\.position, c\.zone, c\.is_revealed, c\.is_achieved, c\.source, c\.no_candidate_reason/.test(sql)) {
      return [cellRows, undefined]
    }
    if (/SELECT pair_key, released_positions, created_at/.test(sql)) {
      return [[], undefined]
    }
    throw new Error(`unmatched SQL: ${sql}`)
  }
  return { query: run, execute: run, end: async () => {} }
}

async function buildApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  app.decorate('io', { to: () => ({ emit: () => {} }) } as never)
  await app.register(async (v1) => { await v1.register(bingoRoutes) }, { prefix: '/api/v1' })
  await app.ready()
  return app
}

function authHeader(): Record<string, string> {
  const token = jwt.sign(
    { sub: USER_ID, event_id: EVENT_ID, display_name: 'テスト太郎', role: 'participant' },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
  return { authorization: `Bearer ${token}` }
}

type ResponseCell = {
  position: number
  is_revealed: boolean
  is_achieved: boolean
  source: string | null
  no_candidate_reason: string | null
  booth: unknown
}

async function getCells(cellRows: CellRow[]): Promise<{ cells: ResponseCell[]; data: Record<string, unknown>; log: string[] }> {
  const log: string[] = []
  const app = await buildApp(makeDb(cellRows, log))
  const res = await app.inject({ method: 'GET', url: `/api/v1/events/${EVENT_ID}/bingo/card`, headers: authHeader() })
  expect(res.statusCode).toBe(200)
  const { data } = res.json()
  await app.close()
  return { cells: data.cells as ResponseCell[], data, log }
}

describe('GET /bingo/card の終端状態のマス（issue #150）', () => {
  it('全制覇で埋まらなかったマスを source=NO_CANDIDATE / reason=ALL_VISITED で返す', async () => {
    const { cells } = await getCells(buildCellRows())

    const terminal = cells.filter((c) => c.source === 'NO_CANDIDATE')
    expect(terminal.map((c) => c.position)).toEqual([0, 1, 4, 7, 13, 15])
    for (const c of terminal) {
      expect(c.no_candidate_reason).toBe('ALL_VISITED')
      expect(c.is_revealed).toBe(true)
      expect(c.is_achieved).toBe(true)
      expect(c.booth).toBeNull() // 載せるブースが存在しない
    }
  })

  it('ブース数不足のマスは reason=INSUFFICIENT_BOOTHS として区別される', async () => {
    const rows = buildCellRows().map((c) =>
      c.source === 'NO_CANDIDATE' ? { ...c, no_candidate_reason: 'INSUFFICIENT_BOOTHS' } : c,
    )
    const { cells } = await getCells(rows)

    const terminal = cells.filter((c) => c.source === 'NO_CANDIDATE')
    expect(terminal).toHaveLength(6)
    expect([...new Set(terminal.map((c) => c.no_candidate_reason))]).toEqual(['INSUFFICIENT_BOOTHS'])
  })

  it('no_candidate_reason は全16マスに必ず存在し、終端状態でなければ null', async () => {
    const { cells } = await getCells(buildCellRows())

    expect(cells).toHaveLength(16)
    for (const c of cells) expect(c).toHaveProperty('no_candidate_reason')
    // source=NO_CANDIDATE のときだけ非 null。逆も成立する（participant-api.md）
    for (const c of cells) {
      expect(c.no_candidate_reason !== null).toBe(c.source === 'NO_CANDIDATE')
    }
  })

  it('終端状態のマスは achieved_cells と lines_completed に算入される', async () => {
    const { data } = await getCells(buildCellRows())

    expect((data.progress as { achieved_cells: number }).achieved_cells).toBe(16)
    expect(data.lines_completed).toBe(10) // 4行 + 4列 + 2対角
  })

  it('カードを何度取得しても、終端状態のマスの埋め直し（自己修復）が走らない', async () => {
    const rows = buildCellRows()
    for (let i = 0; i < 3; i++) {
      const { log } = await getCells(rows)
      // 候補探索（フォールバック割当）の SQL が一切出ない
      expect(log.some((sql) => /FROM booths b/.test(sql))).toBe(false)
      expect(log.some((sql) => /INSERT INTO recommendation_scores/.test(sql))).toBe(false)
    }
    // 元の行が書き換わっていない
    expect(rows.filter((c) => c.source === 'NO_CANDIDATE')).toHaveLength(6)
  })
})
