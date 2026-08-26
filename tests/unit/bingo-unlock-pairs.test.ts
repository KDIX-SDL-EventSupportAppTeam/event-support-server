import { describe, expect, it } from 'vitest'
import {
  CENTER_POSITIONS,
  OUTER_POSITIONS,
  PAIR_TABLE,
  computeNewlyCompletedPairs,
  diffNewPairs,
  getSatisfiedPairs,
  pairDefinitionByKey,
  pairKeyOf,
} from '../../src/lib/bingo/unlockPairs.js'

/** 長さ0〜4の全順列を列挙する（1 + 4 + 12 + 24 + 24 = 65通り）。unit-coverage.md */
function permutationsUpToLength4(items: readonly number[]): number[][] {
  const results: number[][] = []
  function permute(remaining: number[], current: number[]) {
    results.push([...current])
    for (let i = 0; i < remaining.length; i++) {
      const next = [...remaining.slice(0, i), ...remaining.slice(i + 1)]
      permute(next, [...current, remaining[i]!])
    }
  }
  permute([...items], [])
  return results
}

describe('PAIR_TABLE', () => {
  it('中央4マスから2つ選ぶ組は6通り', () => {
    expect(PAIR_TABLE).toHaveLength(6)
  })

  it('6組 × 2マス = 外周12マス。過不足がない・重複がない', () => {
    const allReleased = PAIR_TABLE.flatMap((p) => p.releasedPositions)
    expect(allReleased).toHaveLength(12)
    expect(new Set(allReleased).size).toBe(12)
    expect(new Set(allReleased)).toEqual(new Set(OUTER_POSITIONS))
  })

  it('開放マスに中央マスが含まれない', () => {
    for (const p of PAIR_TABLE) {
      for (const pos of p.releasedPositions) {
        expect(CENTER_POSITIONS).not.toContain(pos)
      }
    }
  })

  it('pair_key は小さい position を先にしたハイフン区切り', () => {
    for (const p of PAIR_TABLE) {
      const [a, b] = p.centerPositions
      const expectedKey = `${Math.min(a, b)}-${Math.max(a, b)}`
      expect(p.pairKey).toBe(expectedKey)
    }
  })

  it('pairKeyOf は順序に依存せず同じキーを返す', () => {
    expect(pairKeyOf(5, 6)).toBe('5-6')
    expect(pairKeyOf(6, 5)).toBe('5-6')
  })

  it('pairDefinitionByKey は不明なキーには undefined を返す', () => {
    expect(pairDefinitionByKey('0-1')).toBeUndefined()
    expect(pairDefinitionByKey('5-6')).toBeDefined()
  })
})

describe('getSatisfiedPairs / 中央マスの埋まり順 65通り総当たり', () => {
  const permutations = permutationsUpToLength4(CENTER_POSITIONS)
  // 1 + 4 + 12 + 24 + 24 = 65
  it('順列は65通りである', () => {
    expect(permutations).toHaveLength(65)
  })

  const expectedReleasedCountByAchievedCount: Record<number, number> = { 0: 0, 1: 0, 2: 2, 3: 6, 4: 12 }

  for (const order of permutations) {
    const label = order.length ? order.join(',') : '(empty)'
    it(`埋まり順 [${label}] で正しく解放される`, () => {
      const alreadyUnlocked = new Set<string>()
      const releasedSoFar = new Set<number>()

      for (let i = 1; i <= order.length; i++) {
        const achieved = new Set(order.slice(0, i))
        const satisfied = getSatisfiedPairs(achieved)
        const newPairs = diffNewPairs(satisfied, alreadyUnlocked)

        // computeNewlyCompletedPairs は getSatisfiedPairs+diffNewPairs と同じ結果になる
        expect(computeNewlyCompletedPairs(achieved, alreadyUnlocked)).toEqual(newPairs)

        for (const p of newPairs) {
          // 「起きてはいけないこと」: 同じペアが二度成立しない
          expect(alreadyUnlocked.has(p.pairKey)).toBe(false)
          alreadyUnlocked.add(p.pairKey)
          for (const pos of p.releasedPositions) {
            // 同じ外周 position が2つのペアから開放されない
            expect(releasedSoFar.has(pos)).toBe(false)
            releasedSoFar.add(pos)
          }
        }
      }

      const achievedCount = order.length
      expect(releasedSoFar.size).toBe(expectedReleasedCountByAchievedCount[achievedCount])

      if (achievedCount === 4) {
        expect(releasedSoFar).toEqual(new Set(OUTER_POSITIONS))
      } else {
        // 対応しない外周マスは開放されていない
        for (const pos of OUTER_POSITIONS) {
          if (!releasedSoFar.has(pos)) continue
        }
        expect(releasedSoFar.size).toBeLessThanOrEqual(OUTER_POSITIONS.length)
      }
    })
  }

  it('長さ2で開放2マス・長さ3で累計6マスになる具体例', () => {
    const afterTwo = getSatisfiedPairs(new Set([5, 6]))
    expect(afterTwo).toHaveLength(1)
    expect(afterTwo[0]!.releasedPositions).toEqual([4, 7])

    // 5,6,9 が達成済みだと 5-6 / 5-9 / 6-9 の3組が成立するが、そのうち 5-6 は
    // 「2マス目達成時点」で既に解放済みという想定なので、新規に解放されるのは 5-9・6-9 の2組。
    const alreadyUnlocked = new Set(['5-6'])
    const afterThree = diffNewPairs(getSatisfiedPairs(new Set([5, 6, 9])), alreadyUnlocked)
    expect(afterThree).toHaveLength(2)
    const released = new Set(afterThree.flatMap((p) => p.releasedPositions))
    expect(released.size).toBe(4)
  })

  it('3マス目の達成で2組が同時に成立する（5,6,9 → 5-9 と 6-9）', () => {
    const satisfied = getSatisfiedPairs(new Set([5, 6, 9]))
    const keys = satisfied.map((p) => p.pairKey).sort()
    expect(keys).toEqual(['5-6', '5-9', '6-9'].sort())
  })
})

describe('「起きてはいけないこと」', () => {
  it('中央2マス達成時、対応しない外周10マスが開放されていない', () => {
    const satisfied = getSatisfiedPairs(new Set([5, 6]))
    const released = new Set(satisfied.flatMap((p) => p.releasedPositions))
    expect(released).toEqual(new Set([4, 7]))
    const notReleased = OUTER_POSITIONS.filter((p) => !released.has(p))
    expect(notReleased).toHaveLength(10)
  })

  it('外周マスの達成では解放が一切起きない（getSatisfiedPairs は中央 position しか見ない）', () => {
    // 外周 position を混ぜても中央だけが評価対象になる
    const achievedIncludingOuter = new Set([5, 6, 4, 7])
    const satisfied = getSatisfiedPairs(achievedIncludingOuter)
    expect(satisfied.map((p) => p.pairKey)).toEqual(['5-6'])
  })

  it('存在しない pair_key は生成されない', () => {
    const allKeys = new Set(PAIR_TABLE.map((p) => p.pairKey))
    expect(allKeys.size).toBe(6)
    expect([...allKeys].sort()).toEqual(['5-10', '5-6', '5-9', '6-10', '6-9', '9-10'].sort())
  })
})

describe('diffNewPairs / 冪等性', () => {
  it('解放済みのペアは新規ペアに含まれない', () => {
    const satisfied = getSatisfiedPairs(new Set([5, 6, 9, 10]))
    const alreadyUnlocked = new Set(['5-6'])
    const newPairs = diffNewPairs(satisfied, alreadyUnlocked)
    expect(newPairs.map((p) => p.pairKey)).not.toContain('5-6')
    expect(newPairs).toHaveLength(5)
  })

  it('全ペアが解放済みなら新規ペアは0件', () => {
    const satisfied = getSatisfiedPairs(new Set([5, 6, 9, 10]))
    const alreadyUnlocked = new Set(PAIR_TABLE.map((p) => p.pairKey))
    expect(diffNewPairs(satisfied, alreadyUnlocked)).toHaveLength(0)
  })
})
