import { describe, expect, it } from 'vitest'
import { deriveFallbackCandidates, pickTopFallbackBoothIds } from '../../src/lib/bingo/fallback.js'

/**
 * docs/specs/bingo-dynamic-unlock/05-recommender/fallback.md
 * 「訪問者数の少ない順」。人気順にしてはならない。
 */
describe('deriveFallbackCandidates（C-5: 候補一覧からの導出）', () => {
  const candidates = [
    { booth_id: 'popular', visitor_count: 30 },
    { booth_id: 'quiet', visitor_count: 0 },
    { booth_id: 'middle', visitor_count: 5 },
  ]

  it('訪問者数の少ない順に並べる（人気順にしない）', () => {
    const result = deriveFallbackCandidates(candidates, new Set())
    expect(result.map((c) => c.boothId)).toEqual(['quiet', 'middle', 'popular'])
    expect(result.map((c) => c.visitors)).toEqual([0, 5, 30])
  })

  it('除外集合のブースを落とす', () => {
    const result = deriveFallbackCandidates(candidates, new Set(['quiet']))
    expect(result.map((c) => c.boothId)).toEqual(['middle', 'popular'])
  })

  it('必要件数だけ取り出しても訪問者数の少ない側から選ばれる', () => {
    const ids = pickTopFallbackBoothIds(deriveFallbackCandidates(candidates, new Set()), 2)
    expect(ids).toEqual(['quiet', 'middle'])
  })

  it('同数はランダムに散る（DB 側の ORDER BY visitors ASC, RAND() と同じ規則）', () => {
    const tied = Array.from({ length: 8 }, (_, i) => ({ booth_id: `b-${i}`, visitor_count: 0 }))
    const orders = new Set<string>()
    for (let i = 0; i < 40; i++) {
      orders.add(
        deriveFallbackCandidates(tied, new Set())
          .map((c) => c.boothId)
          .join(','),
      )
    }
    expect(orders.size).toBeGreaterThan(1)
  })

  it('候補が空なら空を返す', () => {
    expect(deriveFallbackCandidates([], new Set())).toEqual([])
  })
})
