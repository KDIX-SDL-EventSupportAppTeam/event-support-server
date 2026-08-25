import { describe, expect, it } from 'vitest'
import { determinePhase, DEFAULT_PHASE_THRESHOLDS } from '../../src/lib/bingo/phases.js'

describe('determinePhase', () => {
  it('決定表 0件でも例外を投げず COVERAGE になる', () => {
    expect(determinePhase(0)).toBe('COVERAGE')
  })

  it('決定表 29件 で COVERAGE、30件 で SIMILARITY になる（境界）', () => {
    expect(determinePhase(29)).toBe('COVERAGE')
    expect(determinePhase(30)).toBe('SIMILARITY')
  })

  it('決定表 179件 で SIMILARITY、180件 で DRSA になる（境界）', () => {
    expect(determinePhase(179)).toBe('SIMILARITY')
    expect(determinePhase(180)).toBe('DRSA')
  })

  it('負数でも例外を投げず COVERAGE になる', () => {
    expect(determinePhase(-5)).toBe('COVERAGE')
  })

  it('しきい値を設定値で変更でき、変更が即座に反映される', () => {
    const thresholds = { similarityMin: 10, drsaMin: 20 }
    expect(determinePhase(9, thresholds)).toBe('COVERAGE')
    expect(determinePhase(10, thresholds)).toBe('SIMILARITY')
    expect(determinePhase(20, thresholds)).toBe('DRSA')
    // 既定値には影響しない
    expect(DEFAULT_PHASE_THRESHOLDS).toEqual({ similarityMin: 30, drsaMin: 180 })
  })
})
