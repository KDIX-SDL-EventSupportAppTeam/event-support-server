import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../src/db/client.js'
import { ensureCard, CENTER_POSITIONS } from '../../src/lib/bingo/ensureCard.js'

type CardRow = { id: string; event_id: string; user_id: string; status: string; unlocked_at: string | null }
type CellRow = {
  id: string
  card_id: string
  position: number
  zone: string
  booth_id: string | null
  state: string
  source: string | null
}

function makeDb(booths: string[]) {
  const cards: CardRow[] = []
  const cells: CellRow[] = []

  const query = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/SELECT id, status, unlocked_at FROM bingo_cards/.test(sql)) {
      const [eventId, userId] = params as [string, string]
      const row = cards.find((c) => c.event_id === eventId && c.user_id === userId)
      return [row ? [row] : [], undefined]
    }
    if (/SELECT COUNT\(\*\) AS c FROM bingo_cells WHERE card_id = \?/.test(sql)) {
      const [cardId] = params as [string]
      return [[{ c: cells.filter((c) => c.card_id === cardId).length }], undefined]
    }
    // pickSignupBonusBooth の候補クエリ
    if (/FROM booths b\s+WHERE b\.event_id = \? AND b\.is_active = 1/.test(sql)) {
      return [booths.map((id) => ({ id, visitors: 0 })), undefined]
    }
    throw new Error(`unmatched SELECT: ${sql}`)
  }

  const execute = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/INSERT INTO bingo_cards/.test(sql)) {
      const [id, eventId, userId] = params as [string, string, string]
      cards.push({ id, event_id: eventId, user_id: userId, status: 'CENTER_ONLY', unlocked_at: null })
      return [{ affectedRows: 1 }, undefined]
    }
    if (/INSERT INTO bingo_cells/.test(sql)) {
      // 9 カラム × 16行
      for (let i = 0; i < params.length; i += 9) {
        cells.push({
          id: params[i] as string,
          card_id: params[i + 1] as string,
          position: params[i + 2] as number,
          zone: params[i + 3] as string,
          booth_id: params[i + 4] as string | null,
          state: params[i + 5] as string,
          source: params[i + 6] as string | null,
        })
      }
      return [{ affectedRows: params.length / 9 }, undefined]
    }
    throw new Error(`unmatched EXECUTE: ${sql}`)
  }

  const db: DbClient = { query, execute, end: async () => {} }
  return { db, cards, cells }
}

describe('ensureCard', () => {
  it('カード生成直後: 16行・中央4行・EMPTY3行・LOCKED12行・ACHIEVED1行(SIGNUP_BONUS)', async () => {
    const { db, cells } = makeDb(['booth-1', 'booth-2', 'booth-3'])
    const card = await ensureCard(db, 'event-1', 'user-1')

    const cardCells = cells.filter((c) => c.card_id === card.id)
    expect(cardCells).toHaveLength(16)

    const positions = cardCells.map((c) => c.position).sort((a, b) => a - b)
    expect(positions).toEqual(Array.from({ length: 16 }, (_, i) => i))

    const centerCells = cardCells.filter((c) => c.zone === 'CENTER')
    expect(centerCells).toHaveLength(4)
    expect(centerCells.map((c) => c.position).sort()).toEqual([...CENTER_POSITIONS].sort())

    const achieved = cardCells.filter((c) => c.state === 'ACHIEVED')
    expect(achieved).toHaveLength(1)
    expect(achieved[0]!.source).toBe('SIGNUP_BONUS')
    expect(achieved[0]!.booth_id).not.toBeNull()
    expect(centerCells).toContainEqual(expect.objectContaining({ id: achieved[0]!.id }))

    const empty = cardCells.filter((c) => c.state === 'EMPTY')
    expect(empty).toHaveLength(3)
    expect(empty.every((c) => c.zone === 'CENTER')).toBe(true)

    const locked = cardCells.filter((c) => c.state === 'LOCKED')
    expect(locked).toHaveLength(12)
    expect(locked.every((c) => c.zone === 'OUTER')).toBe(true)

    expect(card.status).toBe('CENTER_ONLY')
    expect(card.unlockedAt).toBeNull()
  })

  it('同一ユーザーに対して2回呼んでも同じカードを返す（get-or-create）', async () => {
    const { db } = makeDb(['booth-1'])
    const first = await ensureCard(db, 'event-1', 'user-1')
    const second = await ensureCard(db, 'event-1', 'user-1')
    expect(second.id).toBe(first.id)
  })

  it('候補ブースが0件でもカード生成は失敗しない（E6: pickSignupBonusBooth は例外を投げない）', async () => {
    const { db, cells } = makeDb([])
    const card = await ensureCard(db, 'event-1', 'user-1')
    const cardCells = cells.filter((c) => c.card_id === card.id)
    expect(cardCells).toHaveLength(16)
    const achieved = cardCells.find((c) => c.state === 'ACHIEVED')
    expect(achieved).toBeDefined()
    expect(achieved!.booth_id).toBeNull() // 候補が無いので null のまま
  })
})
