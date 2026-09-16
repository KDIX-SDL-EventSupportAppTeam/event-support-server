import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../src/db/client.js'
import {
  generateManualCode,
  generateUniqueManualCode,
  isValidManualCode,
} from '../../src/lib/manual-code.js'

/** query だけを差し替える最小 DbClient。 */
function makeDb(query: DbClient['query']): DbClient {
  return { query, execute: query, end: async () => {} }
}

describe('generateManualCode（issue #121）', () => {
  it('常に6桁の数字を返す', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateManualCode()
      expect(code).toMatch(/^[0-9]{6}$/)
      expect(code).toHaveLength(6)
    }
  })

  it('先頭ゼロを保持する（000000〜099999 も6桁）', () => {
    // 十分な試行で 100000 未満（＝ゼロ埋めされた）値が少なくとも1つ出る
    let sawPadded = false
    for (let i = 0; i < 20000 && !sawPadded; i++) {
      if (Number(generateManualCode()) < 100000) sawPadded = true
    }
    expect(sawPadded).toBe(true)
  })

  it('連番ではない（連続生成の差が常に1にはならない）', () => {
    const diffs = new Set<number>()
    let prev = Number(generateManualCode())
    for (let i = 0; i < 50; i++) {
      const cur = Number(generateManualCode())
      diffs.add(cur - prev)
      prev = cur
    }
    expect(diffs.size).toBeGreaterThan(1)
  })

  it('isValidManualCode は6桁数字だけを通す', () => {
    expect(isValidManualCode('012345')).toBe(true)
    expect(isValidManualCode('12345')).toBe(false)
    expect(isValidManualCode('1234567')).toBe(false)
    expect(isValidManualCode('12A456')).toBe(false)
    expect(isValidManualCode('DEV001')).toBe(false)
  })
})

describe('generateUniqueManualCode（衝突時リトライ）', () => {
  it('空きが見つかるまで引き直す', async () => {
    let calls = 0
    const db = makeDb(async () => {
      calls++
      // 最初の2回は「使用済み」、3回目で空き
      return [calls < 3 ? [{ x: 1 }] : [], undefined] as [unknown, unknown]
    })
    const code = await generateUniqueManualCode(db, 'event-1')
    expect(code).toMatch(/^[0-9]{6}$/)
    expect(calls).toBe(3)
  })

  it('常に衝突するなら例外を投げる（UNIQUE を握りつぶさない）', async () => {
    const db = makeDb(async () => [[{ x: 1 }], undefined] as [unknown, unknown])
    await expect(generateUniqueManualCode(db, 'event-1')).rejects.toThrow()
  })
})
