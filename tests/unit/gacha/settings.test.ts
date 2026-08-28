import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../../src/db/client.js'
import {
  DEFAULT_GACHA_SETTINGS,
  fetchGachaSettings,
} from '../../../src/lib/gacha/settings.js'

/**
 * 対象: src/lib/gacha/settings.ts
 * 仕様: docs/specs/gacha-and-award/10-testing/unit-coverage.md「設定フォールバック」
 */

const EVENT_ID = '11111111-1111-4111-8111-111111111111'

/** SELECT ... FROM gacha_settings に対して固定の行（または空）を返すだけの偽 DB。 */
function makeDb(rows: unknown[]): DbClient {
  const run = async (sql: string): Promise<[unknown, unknown]> => {
    if (/FROM gacha_settings/.test(sql)) return [rows, undefined]
    throw new Error(`unmatched SQL: ${sql}`)
  }
  return { query: run, execute: run, end: async () => {} }
}

describe('fetchGachaSettings', () => {
  it('行が無いときは既定値を返す（例外にしない）', async () => {
    const got = await fetchGachaSettings(makeDb([]), EVENT_ID)
    expect(got).toEqual(DEFAULT_GACHA_SETTINGS)
    expect(DEFAULT_GACHA_SETTINGS).toEqual({
      isEnabled: false,
      coinsPerLine: 1,
      maxCoins: 4,
      bonusCoins: 0,
    })
  })

  it('行があればその値を返す（is_enabled=1 は true）', async () => {
    const got = await fetchGachaSettings(
      makeDb([{ is_enabled: 1, coins_per_line: 2, max_coins: 10, bonus_coins: 3 }]),
      EVENT_ID,
    )
    expect(got).toEqual({ isEnabled: true, coinsPerLine: 2, maxCoins: 10, bonusCoins: 3 })
  })

  it('is_enabled=0 は false', async () => {
    const got = await fetchGachaSettings(
      makeDb([{ is_enabled: 0, coins_per_line: 1, max_coins: 4, bonus_coins: 0 }]),
      EVENT_ID,
    )
    expect(got.isEnabled).toBe(false)
  })

  it('一部の列が NULL のとき、その列だけ既定値で埋める', async () => {
    const got = await fetchGachaSettings(
      makeDb([{ is_enabled: null, coins_per_line: null, max_coins: 7, bonus_coins: null }]),
      EVENT_ID,
    )
    expect(got).toEqual({ isEnabled: false, coinsPerLine: 1, maxCoins: 7, bonusCoins: 0 })
  })

  it('返り値は毎回新しいオブジェクト（既定値定数を共有しない）', async () => {
    const a = await fetchGachaSettings(makeDb([]), EVENT_ID)
    expect(a).not.toBe(DEFAULT_GACHA_SETTINGS)
  })
})
