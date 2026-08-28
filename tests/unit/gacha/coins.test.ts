import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calcCoinsEarned, type GachaSettings } from '../../../src/lib/gacha/coins.js'

/**
 * 対象: src/lib/gacha/coins.ts の calcCoinsEarned
 * 仕様: docs/specs/gacha-and-award/10-testing/unit-coverage.md
 */

const s = (coinsPerLine: number, maxCoins: number, bonusCoins: number): GachaSettings => ({
  isEnabled: true,
  coinsPerLine,
  maxCoins,
  bonusCoins,
})

describe('calcCoinsEarned — 総当たり 264 通り', () => {
  const linesRange = Array.from({ length: 11 }, (_, i) => i) // 0..10
  const coinsPerLineValues = [0, 1, 2]
  const maxCoinsValues = [0, 1, 4, 50]
  const bonusCoinsValues = [0, 1]

  const cases: { lines: number; cpl: number; max: number; bonus: number }[] = []
  for (const lines of linesRange)
    for (const cpl of coinsPerLineValues)
      for (const max of maxCoinsValues)
        for (const bonus of bonusCoinsValues) cases.push({ lines, cpl, max, bonus })

  it('組み合わせ数がちょうど 264', () => {
    expect(cases).toHaveLength(11 * 3 * 4 * 2)
    expect(cases).toHaveLength(264)
  })

  it.each(cases)(
    'lines=$lines cpl=$cpl max=$max bonus=$bonus → 式と一致し 0 未満にならない',
    ({ lines, cpl, max, bonus }) => {
      const got = calcCoinsEarned(lines, s(cpl, max, bonus))
      const expected = Math.min(lines * cpl, max) + bonus
      expect(got).toBe(expected)
      expect(got).toBeGreaterThanOrEqual(0)
      expect(got).toBeLessThanOrEqual(max + bonus)
      expect(Number.isFinite(got)).toBe(true)
    },
  )

  it.each(
    coinsPerLineValues.flatMap((cpl) =>
      maxCoinsValues.flatMap((max) => bonusCoinsValues.map((bonus) => ({ cpl, max, bonus }))),
    ),
  )('単調非減少: cpl=$cpl max=$max bonus=$bonus で lines を 1 増やしても減らない', ({ cpl, max, bonus }) => {
    for (let lines = 0; lines < 10; lines++) {
      const cur = calcCoinsEarned(lines, s(cpl, max, bonus))
      const next = calcCoinsEarned(lines + 1, s(cpl, max, bonus))
      expect(next).toBeGreaterThanOrEqual(cur)
    }
  })
})

describe('calcCoinsEarned — 確定値の固定表（G-11: 1枚/ライン・上限4枚・ボーナス0）', () => {
  const fixed = s(1, 4, 0)
  const table: [number, number][] = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 4],
    [6, 4],
    [7, 4],
    [8, 4],
    [9, 4],
    [10, 4],
  ]

  it.each(table)('lines=%i → earned=%i', (lines, expected) => {
    expect(calcCoinsEarned(lines, fixed)).toBe(expected)
  })

  it('表全体をまとめて固定（設定を変えたつもりが無いのに換算が変われば落ちる）', () => {
    expect(table.map(([lines]) => calcCoinsEarned(lines, fixed))).toEqual([
      0, 1, 2, 3, 4, 4, 4, 4, 4, 4, 4,
    ])
  })
})

describe('calcCoinsEarned — 境界', () => {
  it('lines=0 は bonusCoins のみ', () => {
    expect(calcCoinsEarned(0, s(1, 4, 0))).toBe(0)
    expect(calcCoinsEarned(0, s(1, 4, 1))).toBe(1)
  })

  it('上限到達の直前は上限未満', () => {
    expect(calcCoinsEarned(3, s(1, 4, 0))).toBe(3)
  })

  it('上限到達点はちょうど maxCoins + bonusCoins', () => {
    expect(calcCoinsEarned(4, s(1, 4, 0))).toBe(4)
    expect(calcCoinsEarned(4, s(1, 4, 1))).toBe(5)
  })

  it('lines=10（全ライン）でも maxCoins + bonusCoins を超えない', () => {
    expect(calcCoinsEarned(10, s(2, 4, 1))).toBe(5)
  })

  it('coinsPerLine=0 はライン数に関わらず bonusCoins', () => {
    for (let lines = 0; lines <= 10; lines++) {
      expect(calcCoinsEarned(lines, s(0, 50, 1))).toBe(1)
    }
  })

  it('maxCoins=0 かつ bonusCoins=0 は常に 0', () => {
    for (let lines = 0; lines <= 10; lines++) {
      expect(calcCoinsEarned(lines, s(2, 0, 0))).toBe(0)
    }
  })

  it('bonusCoins が負（不正データ）でも 0 で止まり、例外を投げない', () => {
    expect(() => calcCoinsEarned(0, s(1, 4, -5))).not.toThrow()
    expect(calcCoinsEarned(0, s(1, 4, -5))).toBe(0)
    expect(calcCoinsEarned(2, s(1, 4, -5))).toBe(0)
    expect(calcCoinsEarned(10, s(1, 4, -1))).toBe(3)
  })
})

describe('calcCoinsEarned — 起きてはいけないこと', () => {
  it('earned が maxCoins + bonusCoins を超えない（総当たり）', () => {
    for (let lines = 0; lines <= 20; lines++) {
      for (const cpl of [0, 1, 2, 5]) {
        for (const max of [0, 1, 4, 50]) {
          for (const bonus of [0, 1, 3]) {
            expect(calcCoinsEarned(lines, s(cpl, max, bonus))).toBeLessThanOrEqual(max + bonus)
          }
        }
      }
    }
  })

  it('設定オブジェクトを書き換えない（純関数）', () => {
    const settings = s(1, 4, 0)
    const snapshot = JSON.stringify(settings)
    calcCoinsEarned(7, settings)
    expect(JSON.stringify(settings)).toBe(snapshot)
  })

  it('lines に負値・小数を与えても NaN / Infinity を返さない', () => {
    for (const lines of [-1, -100, -0.5, 0.5, 3.7, 2.999]) {
      const got = calcCoinsEarned(lines, s(1, 4, 0))
      expect(Number.isNaN(got)).toBe(false)
      expect(Number.isFinite(got)).toBe(true)
      expect(got).toBeGreaterThanOrEqual(0)
    }
  })

  it('src/lib/bingo/ 配下に "gacha" の文字列が無い（依存の向き。G-4）', () => {
    const bingoDir = join(__dirname, '../../../src/lib/bingo')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          walk(full)
        } else if (name.endsWith('.ts')) {
          if (/gacha/i.test(readFileSync(full, 'utf8'))) hits.push(full)
        }
      }
    }
    walk(bingoDir)
    expect(hits).toEqual([])
  })
})
