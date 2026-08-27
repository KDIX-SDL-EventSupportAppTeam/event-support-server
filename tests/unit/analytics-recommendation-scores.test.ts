import { describe, expect, it } from 'vitest'
import {
  aggregateRecommendations,
  isAssigned,
  REC_SCORE_BY_EVENT_SQL,
  type RecScoreRow,
} from '../../src/lib/analytics/recommendationScores.js'

function row(over: Partial<RecScoreRow> = {}): RecScoreRow {
  return {
    unlock_event_id: 'ue1',
    booth_id: 'b1',
    was_assigned: 0,
    strategy: 'mab',
    user_id: 'u1',
    created_at: '2026-08-27 10:00:00',
    ...over,
  }
}

describe('isAssigned', () => {
  it('TINYINT(1) が数値でも文字列でも同じに解釈する', () => {
    expect(isAssigned(1)).toBe(true)
    expect(isAssigned('1')).toBe(true)
    expect(isAssigned(0)).toBe(false)
    expect(isAssigned('0')).toBe(false)
  })

  it('起きてはいけないこと: 1 以外の真値を「割り当て済み」にしない', () => {
    expect(isAssigned(2)).toBe(false)
    expect(isAssigned('')).toBe(false)
  })
})

describe('REC_SCORE_BY_EVENT_SQL', () => {
  it('廃止された recommendations テーブルを参照しない', () => {
    expect(/\brecommendations\b/.test(REC_SCORE_BY_EVENT_SQL)).toBe(false)
    expect(REC_SCORE_BY_EVENT_SQL).toMatch(/FROM recommendation_scores/)
  })

  it('card_unlock_events → bingo_cards を JOIN してイベントで絞る', () => {
    expect(REC_SCORE_BY_EVENT_SQL).toMatch(/JOIN card_unlock_events/)
    expect(REC_SCORE_BY_EVENT_SQL).toMatch(/JOIN bingo_cards/)
    expect(REC_SCORE_BY_EVENT_SQL).toMatch(/WHERE bc\.event_id = \?/)
  })

  it('起きてはいけないこと: users.event_id で絞る（出展者・運営が混ざる）', () => {
    expect(/users/.test(REC_SCORE_BY_EVENT_SQL)).toBe(false)
  })
})

describe('aggregateRecommendations', () => {
  it('候補行を offered、was_assigned=1 を selected として数える', () => {
    const agg = aggregateRecommendations([
      row({ booth_id: 'b1', was_assigned: 1 }),
      row({ booth_id: 'b2', was_assigned: 0 }),
      row({ booth_id: 'b2', was_assigned: 0, unlock_event_id: 'ue2' }),
    ])

    expect(agg.total).toBe(3)
    expect(agg.boothOfferedCount).toEqual({ b1: 1, b2: 2 })
    expect(agg.boothSelectedCount).toEqual({ b1: 1 })
    expect(agg.selectedCount).toBe(1)
    expect(agg.openCount).toBe(2)
  })

  it('was_assigned が文字列で返っても数え漏らさない', () => {
    const agg = aggregateRecommendations([
      row({ was_assigned: '1' }),
      row({ was_assigned: '0' }),
    ])

    expect(agg.selectedCount).toBe(1)
    expect(agg.openCount).toBe(1)
  })

  it('selected + open が total と一致する（取りこぼしがない）', () => {
    const agg = aggregateRecommendations([
      row({ was_assigned: 1 }),
      row({ was_assigned: '1' }),
      row({ was_assigned: 0 }),
      row({ was_assigned: '0' }),
    ])

    expect(agg.selectedCount + agg.openCount).toBe(agg.total)
  })

  it('algorithm は strategy の最頻値。候補行数ではなく解放イベント数で数える', () => {
    // ue1(random) は候補5件、ue2/ue3(mab) は候補1件ずつ。
    // 行数で数えると random が勝つが、解放イベント数では mab が 2 対 1 で勝つ。
    const rows: RecScoreRow[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        row({ unlock_event_id: 'ue1', strategy: 'random', booth_id: `b${i}` }),
      ),
      row({ unlock_event_id: 'ue2', strategy: 'mab' }),
      row({ unlock_event_id: 'ue3', strategy: 'mab' }),
    ]

    expect(aggregateRecommendations(rows).algorithm).toBe('mab')
  })

  it('行が無ければ算出せず既定値 mab を返す', () => {
    const agg = aggregateRecommendations([])

    expect(agg.algorithm).toBe('mab')
    expect(agg.total).toBe(0)
    expect(agg.selectedCount).toBe(0)
    expect(agg.openCount).toBe(0)
    expect(agg.boothOfferedCount).toEqual({})
  })

  it('strategy が NULL の行があっても落ちない', () => {
    const agg = aggregateRecommendations([
      row({ unlock_event_id: 'ue1', strategy: null }),
      row({ unlock_event_id: 'ue2', strategy: 'phase2' }),
    ])

    expect(agg.algorithm).toBe('phase2')
  })

  it('同数のときは実行ごとに結果が揺れない', () => {
    const rows: RecScoreRow[] = [
      row({ unlock_event_id: 'ue1', strategy: 'zzz' }),
      row({ unlock_event_id: 'ue2', strategy: 'aaa' }),
    ]

    const first = aggregateRecommendations(rows).algorithm
    expect(aggregateRecommendations([...rows].reverse()).algorithm).toBe(first)
  })
})
