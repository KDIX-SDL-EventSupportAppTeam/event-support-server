import { describe, expect, it } from 'vitest'
import { parseRecommendResponse } from '../../src/lib/bingo/recommenderClient.js'

/**
 * docs/specs/recommender-phase-linkage/10-testing.md T-22〜T-26
 *
 * 契約（05-recommender/contract.md、本リポジトリが正本）は `rank`。
 * 推薦エンジンの現行実装は `rank_in_event` を返す。デプロイ順序が前後しても
 * `recommendation_scores.rank_in_event` が欠損しないよう両方受ける。
 */
describe('parseRecommendResponse（rank / rank_in_event の両対応）', () => {
  const base = { phase: 'COVERAGE', assigned: [], scores: [] }

  it('T-22 scores[].rank を返す応答で rank が記録される', () => {
    const res = parseRecommendResponse({
      ...base,
      scores: [{ booth_id: 'b1', score: 0.9, rank: 3, interest_match: 'MATCH' }],
    })
    expect(res?.scores[0].rank).toBe(3)
  })

  it('T-23 rank_in_event だけの応答（旧実装）でも記録される', () => {
    const res = parseRecommendResponse({
      ...base,
      scores: [{ booth_id: 'b1', score: 0.9, rank_in_event: 7, interest_match: 'MATCH' }],
    })
    expect(res?.scores[0].rank).toBe(7)
  })

  it('T-24 両方あるときは rank を優先する', () => {
    const res = parseRecommendResponse({
      ...base,
      scores: [{ booth_id: 'b1', rank: 1, rank_in_event: 9, interest_match: 'MATCH' }],
    })
    expect(res?.scores[0].rank).toBe(1)
  })

  it('T-25 どちらも無ければ null（NULL で記録し解放は成功する）', () => {
    const res = parseRecommendResponse({
      ...base,
      scores: [{ booth_id: 'b1', score: 0.5, interest_match: 'UNKNOWN' }],
    })
    expect(res?.scores[0].rank).toBeNull()
  })

  it('T-26 assigned[] でも rank / rank_in_event を両方受け、score/rank が無くても割当が成立する', () => {
    const res = parseRecommendResponse({
      ...base,
      assigned: [
        { booth_id: 'a1', rank_in_event: 2 },
        { booth_id: 'a2' },
      ],
    })
    expect(res?.assigned).toEqual([
      { booth_id: 'a1', score: null, rank: 2 },
      { booth_id: 'a2', score: null, rank: null },
    ])
  })
})
