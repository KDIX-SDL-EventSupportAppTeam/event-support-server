import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../src/db/client.js'
import { ensureCard, findCard } from '../../src/lib/bingo/ensureCard.js'
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

/**
 * 一意制約（uq_card_event_user / uq_cell_card_position / uq_unlock_card_pair）を
 * 実際に守るフェイク DB。さくらプロキシ（ADR 0001）と同じ振る舞いを再現する:
 *
 * - `ON DUPLICATE KEY UPDATE` 付きの INSERT が重複した → affectedRows=0（例外なし）
 * - 素の INSERT が重複した → **code を持たない汎用 Error**。`err.code === 'ER_DUP_ENTRY'`
 *   では捕捉できず 500 になる（今回のバグそのもの）
 *
 * つまり重複キーを catch で捌く実装へ戻すと、競合系のテストが必ず落ちる。
 */
function makeDb(opts: { booths: string[] | string[][]; interestCategoryIds?: string[] }) {
  const { booths, interestCategoryIds = [] } = opts
  const cards: CardRow[] = []
  const cells: CellRow[] = []
  const unlockEvents: UnlockEventRow[] = []
  const scores: ScoreRow[] = []
  /** ブース候補は呼び出しごとに変えられる（競合する2本が別のブースを選ぶ状況の再現用） */
  const boothBatches: string[][] = Array.isArray(booths[0]) ? (booths as string[][]) : [booths as string[]]
  let boothCall = 0

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
    if (/SELECT booth_id FROM bingo_cells WHERE card_id = \? AND position = \?/.test(sql)) {
      const [cardId, position] = params as [string, number]
      const row = cells.find((c) => c.card_id === cardId && c.position === position)
      return [row ? [{ booth_id: row.booth_id }] : [], undefined]
    }
    if (/SELECT id FROM card_unlock_events WHERE card_id = \? AND pair_key = 'PRESURVEY'/.test(sql)) {
      const [cardId] = params as [string]
      const row = unlockEvents.find((e) => e.card_id === cardId && e.pair_key === 'PRESURVEY')
      return [row ? [{ id: row.id }] : [], undefined]
    }
    if (/SELECT custom_answers FROM user_survey_answers/.test(sql)) {
      if (!interestCategoryIds.length) return [[], undefined]
      return [[{ custom_answers: JSON.stringify({ interest_categories: interestCategoryIds }) }], undefined]
    }
    if (/FROM booths b\s+WHERE b\.event_id = \? AND b\.is_active = 1 AND b\.category_id IN/.test(sql)) {
      const batch = boothBatches[Math.min(boothCall, boothBatches.length - 1)]!
      boothCall += 1
      return [batch.map((id) => ({ id, visitors: 0 })), undefined]
    }
    if (/SELECT COUNT\(\*\) AS c FROM check_ins ci\s+JOIN users u/.test(sql)) {
      return [[{ c: 0 }], undefined]
    }
    throw new Error(`unmatched SELECT: ${sql}`)
  }

  /** プロキシは MySQL のエラーを code の無い 500 に潰す（ADR 0001） */
  const onDuplicate = (sql: string): [unknown, unknown] => {
    if (!/ON DUPLICATE KEY UPDATE/.test(sql)) {
      throw new Error('[sakura-proxy] 500: Internal Server Error')
    }
    return [{ affectedRows: 0 }, undefined]
  }

  const execute = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/INSERT INTO bingo_cards/.test(sql)) {
      const [id, eventId, userId] = params as [string, string, string]
      if (cards.some((c) => c.event_id === eventId && c.user_id === userId)) {
        return onDuplicate(sql) // uq_card_event_user
      }
      cards.push({ id, event_id: eventId, user_id: userId })
      return [{ affectedRows: 1 }, undefined]
    }
    if (/INSERT INTO bingo_cells/.test(sql)) {
      // 9 カラム × 16行 (id, card_id, position, zone, booth_id, is_revealed, is_achieved, source, assigned_at)
      let inserted = 0
      for (let i = 0; i < params.length; i += 9) {
        const cardId = params[i + 1] as string
        const position = params[i + 2] as number
        if (cells.some((c) => c.card_id === cardId && c.position === position)) {
          onDuplicate(sql) // uq_cell_card_position
          continue
        }
        cells.push({
          id: params[i] as string,
          card_id: cardId,
          position,
          zone: params[i + 3] as string,
          booth_id: params[i + 4] as string | null,
          is_revealed: params[i + 5] as number,
          is_achieved: params[i + 6] as number,
          source: params[i + 7] as string | null,
        })
        inserted += 1
      }
      return [{ affectedRows: inserted }, undefined]
    }
    if (/INSERT INTO card_unlock_events/.test(sql)) {
      const [id, cardId, pairKey] = params as [string, string, string]
      if (unlockEvents.some((e) => e.card_id === cardId && e.pair_key === pairKey)) {
        return onDuplicate(sql) // uq_unlock_card_pair
      }
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

  // ホーム初回表示では GET /bingo/card と GET /gacha/coins が同時に走り得た。
  // 重複キーを例外で捌く実装だと、プロキシ経由（ADR 0001）で片方が 500 になる。
  it('同時に2本呼ばれても例外にならず、カードもマスも二重に作られない', async () => {
    const { db, cards, cells, unlockEvents, scores } = makeDb({
      booths: ['booth-1', 'booth-2', 'booth-3'],
      interestCategoryIds: ['cat-1'],
    })

    const [a, b] = await Promise.all([
      ensureCard(db, 'event-1', 'user-1'),
      ensureCard(db, 'event-1', 'user-1'),
    ])

    expect(a.id).toBe(b.id)
    expect(cards).toHaveLength(1)
    expect(cells.filter((c) => c.card_id === a.id)).toHaveLength(16)
    expect(unlockEvents).toHaveLength(1)
    expect(scores).toHaveLength(1) // 一意制約が無い追記テーブル。二重記録されないこと
  })

  it('競合に負けた側は、自分が選んだブースではなくカードに載ったブースを記録する', async () => {
    const { db, cells, scores } = makeDb({
      // 2本が別々のブースを選ぶ状況。候補が1件なら pickPreSurveyBooth の戻り値は決定的
      booths: [['booth-a'], ['booth-b']],
      interestCategoryIds: ['cat-1'],
    })

    const [card] = await Promise.all([
      ensureCard(db, 'event-1', 'user-1'),
      ensureCard(db, 'event-1', 'user-1'),
    ])

    const cell5 = cells.find((c) => c.card_id === card.id && c.position === 5)!
    expect(scores).toHaveLength(1)
    // recommendation_scores がカードに存在しないブースを指してはならない
    expect(scores[0]!.booth_id).toBe(cell5.booth_id)
  })
})

describe('findCard', () => {
  it('カードが無ければ null を返し、作らない（コイン枚数の参照用）', async () => {
    const { db, cards } = makeDb({ booths: ['booth-1'], interestCategoryIds: ['cat-1'] })
    expect(await findCard(db, 'event-1', 'user-1')).toBeNull()
    expect(cards).toHaveLength(0)
  })

  it('カードがあれば同じ id を返す', async () => {
    const { db } = makeDb({ booths: ['booth-1'], interestCategoryIds: ['cat-1'] })
    const created = await ensureCard(db, 'event-1', 'user-1')
    expect((await findCard(db, 'event-1', 'user-1'))?.id).toBe(created.id)
  })
})
