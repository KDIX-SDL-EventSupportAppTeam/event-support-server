import { describe, expect, it } from 'vitest'
import { countCompletedLines, calcCoinsEarned, LINES } from '../../src/lib/bingo/lines.js'

describe('LINES', () => {
  it('4行 + 4列 + 2対角 = 全10ライン', () => {
    expect(LINES).toHaveLength(10)
  })
})

describe('countCompletedLines', () => {
  it('空集合は0', () => {
    expect(countCompletedLines(new Set())).toBe(0)
  })

  it('中央2x2（5,6,9,10）が全て揃ってもラインは1本も成立しない', () => {
    // README 絶対制約4 / lines-and-coins.md: 中央4マス完成でコインを配らない
    expect(countCompletedLines(new Set([5, 6, 9, 10]))).toBe(0)
  })

  it('1行が揃うと1ライン成立', () => {
    expect(countCompletedLines(new Set([0, 1, 2, 3]))).toBe(1)
  })

  it('1列が揃うと1ライン成立', () => {
    expect(countCompletedLines(new Set([0, 4, 8, 12]))).toBe(1)
  })

  it('対角が揃うと1ライン成立', () => {
    expect(countCompletedLines(new Set([0, 5, 10, 15]))).toBe(1)
    expect(countCompletedLines(new Set([3, 6, 9, 12]))).toBe(1)
  })

  it('全16マス達成で全10ラインが成立する', () => {
    const all = new Set(Array.from({ length: 16 }, (_, i) => i))
    expect(countCompletedLines(all)).toBe(10)
  })
})

describe('calcCoinsEarned', () => {
  it('4ライン以上は4でクリップされる', () => {
    // 4行がすべて揃う（=16マス全達成の一部）
    const all = new Set(Array.from({ length: 16 }, (_, i) => i))
    expect(calcCoinsEarned(all)).toBe(4)
  })

  it('中央4マスのみでは0枚', () => {
    expect(calcCoinsEarned(new Set([5, 6, 9, 10]))).toBe(0)
  })

  it('1ライン成立で1枚', () => {
    expect(calcCoinsEarned(new Set([0, 1, 2, 3]))).toBe(1)
  })

  it('再計算方式であること（同じ達成状態に対して常に同じ値を返す＝二重加算しない）', () => {
    const achieved = new Set([0, 1, 2, 3, 4, 5, 6, 7])
    const first = calcCoinsEarned(achieved)
    const second = calcCoinsEarned(achieved)
    expect(first).toBe(second)
    expect(first).toBe(2)
  })
})
