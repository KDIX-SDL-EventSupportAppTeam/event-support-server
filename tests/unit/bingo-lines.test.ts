import { describe, expect, it } from 'vitest'
import { countCompletedLines, completedLineIndexes, LINES } from '../../src/lib/bingo/lines.js'

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
    // README 絶対制約4 / D-5: 中央4マス完成でコインを配らない・ラインも成立しない
    expect(countCompletedLines(new Set([5, 6, 9, 10]))).toBe(0)
  })

  it('中央2 + 同一ラインの外周2 で1になる（4件の訪問でビンゴ1本）', () => {
    expect(countCompletedLines(new Set([4, 5, 6, 7]))).toBe(1)
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

  it('達成した順序に依存しない（集合だけで決まる）', () => {
    const order1 = new Set([0, 1, 2, 3])
    const order2 = new Set([3, 2, 1, 0])
    expect(countCompletedLines(order1)).toBe(countCompletedLines(order2))
  })
})

describe('completedLineIndexes', () => {
  it('成立しているラインの index を返す', () => {
    expect(completedLineIndexes(new Set([0, 1, 2, 3]))).toEqual([0])
    expect(completedLineIndexes(new Set())).toEqual([])
  })
})
