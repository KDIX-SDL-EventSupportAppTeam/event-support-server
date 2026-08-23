import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { unlockCard } from '../../src/lib/bingo/unlock.js'

const config: AppConfig = {
  port: 3000,
  databaseUrl: 'mysql://test',
  sakuraProxyUrl: undefined,
  sakuraProxyKey: undefined,
  jwtSecret: 'secret',
  webhookApiKey: '',
  recommenderUrl: '', // 未設定 → 常にフォールバックへ（05-recommender/contract.md）
  recommenderTimeoutMs: 1500,
  checkinCooldownSec: 0,
  ratingScale: 3,
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
}

type Card = { id: string; status: 'CENTER_ONLY' | 'UNLOCKED'; unlocked_at: string | null }
type Cell = {
  id: string
  card_id: string
  position: number
  zone: 'CENTER' | 'OUTER'
  booth_id: string | null
  state: 'LOCKED' | 'EMPTY' | 'ACHIEVED'
  source: string | null
}
type Booth = { id: string; event_id: string; is_active: number }
type AssignmentLog = { id: string; cell_id: string; strategy: string; global_checkin_count: number }

/**
 * unlockCard の結合テスト用インメモリ DB。
 * assignOuterCells / fallback.ts が実際に発行する SQL パターンにのみ対応する。
 */
function makeUnlockTestDb(opts: { card: Card; cells: Cell[]; boothCount: number }) {
  const { card, cells } = opts
  const booths: Booth[] = Array.from({ length: opts.boothCount }, (_, i) => ({
    id: `booth-${i}`,
    event_id: 'event-1',
    is_active: 1,
  }))
  const assignmentLogs: AssignmentLog[] = []

  const query = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/SELECT id, position FROM bingo_cells WHERE card_id = \? AND state = 'LOCKED'/.test(sql)) {
      const rows = cells
        .filter((c) => c.card_id === params[0] && c.state === 'LOCKED')
        .sort((a, b) => a.position - b.position)
        .map((c) => ({ id: c.id, position: c.position }))
      return [rows, undefined]
    }
    if (/SELECT booth_id, source FROM bingo_cells WHERE card_id = \? AND zone = 'CENTER'/.test(sql)) {
      const rows = cells
        .filter((c) => c.card_id === params[0] && c.zone === 'CENTER')
        .map((c) => ({ booth_id: c.booth_id, source: c.source }))
      return [rows, undefined]
    }
    if (/SELECT DISTINCT booth_id FROM check_ins/.test(sql)) {
      return [[], undefined]
    }
    if (/SELECT id FROM booths WHERE event_id = \? AND is_active = 0/.test(sql)) {
      return [[], undefined]
    }
    if (/SELECT ci\.booth_id, ci\.visit_order, bc\.source, br\.rating/.test(sql)) {
      const rows = cells
        .filter((c) => c.card_id === params[0] && c.zone === 'CENTER' && c.booth_id)
        .map((c, idx) => ({ booth_id: c.booth_id, visit_order: idx, source: c.source, rating: null }))
      return [rows, undefined]
    }
    if (/SELECT COUNT\(\*\) AS c FROM check_ins ci\s+JOIN users u/.test(sql)) {
      return [[{ c: 42 }], undefined]
    }
    if (/SELECT b\.id, COUNT\(ci\.id\) AS visitors/.test(sql)) {
      // fallback.ts: exclude 済みブースを除いた候補を visitors 昇順で返す
      const excludeList = params.slice(1) as string[]
      const candidates = booths.filter((b) => b.is_active === 1 && !excludeList.includes(b.id))
      return [candidates.map((b) => ({ id: b.id })), undefined]
    }
    if (/SELECT id FROM booths WHERE event_id = \? AND is_active = 1 AND id IN/.test(sql)) {
      return [[], undefined]
    }
    throw new Error(`unmatched SELECT: ${sql}`)
  }

  const execute = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/UPDATE bingo_cards SET status = 'UNLOCKED'/.test(sql)) {
      const [unlockedAt, , cardId] = params as [string, string, string]
      if (card.id === cardId && card.status === 'CENTER_ONLY') {
        card.status = 'UNLOCKED'
        card.unlocked_at = unlockedAt
        return [{ affectedRows: 1 }, undefined]
      }
      return [{ affectedRows: 0 }, undefined]
    }
    if (/UPDATE bingo_cells\s+SET booth_id = CASE id/.test(sql)) {
      // params: [id,boothId]*N, [id,source]*N, [id,assignedAt]*N, ids...N
      const n = (params.length - cells.filter((c) => c.card_id === card.id && c.state === 'LOCKED').length) / 3
      // 単純化: WHEN 節から id→boothId, id→source を復元する
      const idCount = cells.filter((c) => c.card_id === card.id && c.state === 'LOCKED').length
      const boothPairs = params.slice(0, idCount * 2)
      const sourcePairs = params.slice(idCount * 2, idCount * 4)
      for (let i = 0; i < idCount; i++) {
        const id = boothPairs[i * 2] as string
        const boothId = boothPairs[i * 2 + 1] as string | null
        const source = sourcePairs[i * 2 + 1] as string | null
        const cell = cells.find((c) => c.id === id)
        if (cell) {
          cell.booth_id = boothId
          cell.state = 'EMPTY'
          cell.source = source
        }
      }
      void n
      return [{ affectedRows: idCount }, undefined]
    }
    if (/INSERT INTO cell_assignment_logs/.test(sql)) {
      // 6 params per row: id, cell_id, strategy, score, reason_payload, global_checkin_count
      for (let i = 0; i < params.length; i += 6) {
        assignmentLogs.push({
          id: params[i] as string,
          cell_id: params[i + 1] as string,
          strategy: params[i + 2] as string,
          global_checkin_count: params[i + 5] as number,
        })
      }
      return [{ affectedRows: params.length / 6 }, undefined]
    }
    throw new Error(`unmatched EXECUTE: ${sql}`)
  }

  const db: DbClient = { query, execute, end: async () => {} }
  return { db, assignmentLogs, cells, card }
}

function buildCard(): { card: Card; cells: Cell[] } {
  const card: Card = { id: 'card-1', status: 'CENTER_ONLY', unlocked_at: null }
  const cells: Cell[] = []
  const centerPositions = [5, 6, 9, 10]
  for (let pos = 0; pos < 16; pos++) {
    const isCenter = centerPositions.includes(pos)
    cells.push({
      id: `cell-${pos}`,
      card_id: card.id,
      position: pos,
      zone: isCenter ? 'CENTER' : 'OUTER',
      booth_id: isCenter ? `visited-${pos}` : null,
      state: isCenter ? 'ACHIEVED' : 'LOCKED',
      source: isCenter ? 'FREE_VISIT' : null,
    })
  }
  return { card, cells }
}

describe('unlockCard', () => {
  it('中央4マス完成時に解放し、外側12マスがフォールバックで埋まる（推薦未設定）', async () => {
    const { card, cells } = buildCard()
    const { db, assignmentLogs } = makeUnlockTestDb({ card, cells, boothCount: 40 })

    const result = await unlockCard(db, config, 'event-1', 'user-1', card.id)

    expect(result.unlocked).toBe(true)
    expect(card.status).toBe('UNLOCKED')

    const outerCells = cells.filter((c) => c.zone === 'OUTER')
    expect(outerCells).toHaveLength(12)
    expect(outerCells.every((c) => c.state === 'EMPTY')).toBe(true)
    expect(outerCells.every((c) => c.booth_id !== null)).toBe(true)
    // 重複ブースが入らないこと
    const boothIds = outerCells.map((c) => c.booth_id)
    expect(new Set(boothIds).size).toBe(boothIds.length)

    // strategy='FALLBACK_COVERAGE' で12行記録される
    expect(assignmentLogs).toHaveLength(12)
    expect(assignmentLogs.every((l) => l.strategy === 'FALLBACK_COVERAGE')).toBe(true)
    expect(assignmentLogs.every((l) => l.global_checkin_count === 42)).toBe(true)
  })

  it('冪等性: 既に UNLOCKED のカードに対して再度呼んでも unlocked=false（affectedRows=0）', async () => {
    const { card, cells } = buildCard()
    card.status = 'UNLOCKED' // 既に解放済み
    const { db } = makeUnlockTestDb({ card, cells, boothCount: 40 })

    const result = await unlockCard(db, config, 'event-1', 'user-1', card.id)
    expect(result.unlocked).toBe(false)
    expect(result.unlockedAt).toBeNull()
  })

  it('候補ブースが12件に満たない場合、埋められるだけ埋めて残りは EMPTY/booth_id=NULL のままにする（E13）', async () => {
    const { card, cells } = buildCard()
    const { db } = makeUnlockTestDb({ card, cells, boothCount: 5 }) // 候補5件のみ（12マスに満たない）

    const result = await unlockCard(db, config, 'event-1', 'user-1', card.id)
    expect(result.unlocked).toBe(true)

    const outerCells = cells.filter((c) => c.zone === 'OUTER')
    const filled = outerCells.filter((c) => c.booth_id !== null)
    const empty = outerCells.filter((c) => c.booth_id === null)
    expect(filled).toHaveLength(5)
    expect(empty).toHaveLength(7)
    // LOCKED のまま放置しない
    expect(outerCells.every((c) => c.state === 'EMPTY')).toBe(true)
  })
})
