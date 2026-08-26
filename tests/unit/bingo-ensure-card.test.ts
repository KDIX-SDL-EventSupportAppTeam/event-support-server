import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../src/db/client.js'
import { ensureCard } from '../../src/lib/bingo/ensureCard.js'
import { CENTER_POSITIONS } from '../../src/lib/bingo/unlockPairs.js'

type CardRow = { id: string; event_id: string; user_id: string }
type CellRow = {
  id: string
  card_id: string
  position: number
  zone: string
  booth_id: string | null
  is_revealed: number
  is_achieved: number
  source: string | null
}
type UnlockEventRow = { id: string; card_id: string; pair_key: string }
type ScoreRow = { unlock_event_id: string; booth_id: string; was_assigned: number }

function makeDb(opts: { booths: string[]; interestCategoryIds?: string[] }) {
  const { booths, interestCategoryIds = [] } = opts
  const cards: CardRow[] = []
  const cells: CellRow[] = []
  const unlockEvents: UnlockEventRow[] = []
  const scores: ScoreRow[] = []

  const query = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/SELECT id FROM bingo_cards WHERE event_id = \? AND user_id = \?/.test(sql)) {
      const [eventId, userId] = params as [string, string]
      const row = cards.find((c) => c.event_id === eventId && c.user_id === userId)
      return [row ? [row] : [], undefined]
    }
    if (/SELECT COUNT\(\*\) AS c FROM bingo_cells WHERE card_id = \?/.test(sql)) {
      const [cardId] = params as [string]
      return [[{ c: cells.filter((c) => c.card_id === cardId).length }], undefined]
    }
    if (/SELECT custom_answers FROM user_survey_answers/.test(sql)) {
      if (!interestCategoryIds.length) return [[], undefined]
      return [[{ custom_answers: JSON.stringify({ interest_categories: interestCategoryIds }) }], undefined]
    }
    if (/FROM booths b\s+WHERE b\.event_id = \? AND b\.is_active = 1 AND b\.category_id IN/.test(sql)) {
      return [booths.map((id) => ({ id, visitors: 0 })), undefined]
    }
    if (/SELECT COUNT\(\*\) AS c FROM check_ins ci\s+JOIN users u/.test(sql)) {
      return [[{ c: 0 }], undefined]
    }
    throw new Error(`unmatched SELECT: ${sql}`)
  }

  const execute = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/INSERT INTO bingo_cards/.test(sql)) {
      const [id, eventId, userId] = params as [string, string, string]
      cards.push({ id, event_id: eventId, user_id: userId })
      return [{ affectedRows: 1 }, undefined]
    }
    if (/INSERT INTO bingo_cells/.test(sql)) {
      // 9 カラム × 16行 (id, card_id, position, zone, booth_id, is_revealed, is_achieved, source, assigned_at)
      for (let i = 0; i < params.length; i += 9) {
        cells.push({
          id: params[i] as string,
          card_id: params[i + 1] as string,
          position: params[i + 2] as number,
          zone: params[i + 3] as string,
          booth_id: params[i + 4] as string | null,
          is_revealed: params[i + 5] as number,
          is_achieved: params[i + 6] as number,
          source: params[i + 7] as string | null,
        })
      }
      return [{ affectedRows: params.length / 9 }, undefined]
    }
    if (/INSERT INTO card_unlock_events/.test(sql)) {
      const [id, cardId, pairKey] = params as [string, string, string]
      unlockEvents.push({ id, card_id: cardId, pair_key: pairKey })
      return [{ affectedRows: 1 }, undefined]
    }
    if (/INSERT INTO recommendation_scores/.test(sql)) {
      const [, unlockEventId, , boothId, , , wasAssigned] = params as [
        string,
        string,
        string,
        string,
        unknown,
        unknown,
        number,
      ]
      scores.push({ unlock_event_id: unlockEventId, booth_id: boothId, was_assigned: wasAssigned })
      return [{ affectedRows: 1 }, undefined]
    }
    throw new Error(`unmatched EXECUTE: ${sql}`)
  }

  const db: DbClient = { query, execute, end: async () => {} }
  return { db, cards, cells, unlockEvents, scores }
}

describe('ensureCard', () => {
  it('アンケート回答済み: 16行・中央4行・is_achieved=1が0行・position5がPRESURVEYで見える', async () => {
    const { db, cells, unlockEvents, scores } = makeDb({
      booths: ['booth-1', 'booth-2', 'booth-3'],
      interestCategoryIds: ['cat-1'],
    })
    const card = await ensureCard(db, 'event-1', 'user-1')

    const cardCells = cells.filter((c) => c.card_id === card.id)
    expect(cardCells).toHaveLength(16)

    const positions = cardCells.map((c) => c.position).sort((a, b) => a - b)
    expect(positions).toEqual(Array.from({ length: 16 }, (_, i) => i))

    const centerCells = cardCells.filter((c) => c.zone === 'CENTER')
    expect(centerCells).toHaveLength(4)
    expect(centerCells.map((c) => c.position).sort()).toEqual([...CENTER_POSITIONS].sort())

    // 参加ボーナスは廃止（D-1）。is_achieved=1 の行は0行
    expect(cardCells.filter((c) => c.is_achieved === 1)).toHaveLength(0)

    const revealed = cardCells.filter((c) => c.is_revealed === 1)
    expect(revealed).toHaveLength(1)
    expect(revealed[0]!.position).toBe(5)
    expect(revealed[0]!.source).toBe('PRESURVEY')
    expect(revealed[0]!.booth_id).not.toBeNull()

    // 事前推薦も推薦の一種として card_unlock_events / recommendation_scores に記録される
    expect(unlockEvents).toHaveLength(1)
    expect(unlockEvents[0]!.pair_key).toBe('PRESURVEY')
    expect(scores).toHaveLength(1)
    expect(scores[0]!.was_assigned).toBe(1)
  })

  it('E1: アンケート未回答でもカード生成は成功し、is_revealed=1の行は0行', async () => {
    const { db, cells, unlockEvents } = makeDb({ booths: ['booth-1'], interestCategoryIds: [] })
    const card = await ensureCard(db, 'event-1', 'user-1')
    const cardCells = cells.filter((c) => c.card_id === card.id)
    expect(cardCells).toHaveLength(16)
    expect(cardCells.filter((c) => c.is_revealed === 1)).toHaveLength(0)
    expect(cardCells.filter((c) => c.is_achieved === 1)).toHaveLength(0)
    // card_unlock_events は0行または PRESURVEY の1行のみ、この場合は0行
    expect(unlockEvents).toHaveLength(0)
  })

  it('同一ユーザーに対して2回呼んでも同じカードを返す（get-or-create）', async () => {
    const { db } = makeDb({ booths: ['booth-1'], interestCategoryIds: ['cat-1'] })
    const first = await ensureCard(db, 'event-1', 'user-1')
    const second = await ensureCard(db, 'event-1', 'user-1')
    expect(second.id).toBe(first.id)
  })

  it('E3: 関心分野に一致するブースが1つも無くてもカード生成は失敗しない', async () => {
    const { db, cells } = makeDb({ booths: [], interestCategoryIds: ['cat-1'] })
    const card = await ensureCard(db, 'event-1', 'user-1')
    const cardCells = cells.filter((c) => c.card_id === card.id)
    expect(cardCells).toHaveLength(16)
    expect(cardCells.filter((c) => c.is_revealed === 1)).toHaveLength(0)
  })
})
