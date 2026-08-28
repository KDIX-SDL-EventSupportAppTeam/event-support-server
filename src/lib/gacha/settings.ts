/**
 * ガチャ設定（換算規則）の取得。
 *
 * `gacha_settings` はイベント単位。行が無いイベント・一部の列が NULL のイベントでも
 * 例外にせず、コード側の既定値で埋めて返す（schema.md「行が無いとき」/ G-3）。
 *
 * 仕様: docs/specs/gacha-and-award/02-data-model/schema.md
 */
import type { DbClient } from '../../db/client.js'
import type { GachaSettings } from './coins.js'

/** 設定行が無い／列が NULL のときに使う既定値。 */
export const DEFAULT_GACHA_SETTINGS: GachaSettings = {
  isEnabled: false,
  coinsPerLine: 1,
  maxCoins: 4,
  bonusCoins: 0,
}

interface GachaSettingsRow {
  is_enabled: number | null
  coins_per_line: number | null
  max_coins: number | null
  bonus_coins: number | null
}

/** 数値列。NULL / 未定義なら既定値で埋める。 */
function numOr(value: number | null | undefined, fallback: number): number {
  return value === null || value === undefined ? fallback : Number(value)
}

/**
 * イベントの換算規則を取得する。行が無ければ既定値を返す。
 * **設定行の有無で 500 を出さないこと。**
 */
export async function fetchGachaSettings(
  db: DbClient,
  eventId: string,
): Promise<GachaSettings> {
  const [rows] = await db.query(
    `SELECT is_enabled, coins_per_line, max_coins, bonus_coins
       FROM gacha_settings
      WHERE event_id = ?
      LIMIT 1`,
    [eventId],
  )
  const row = (rows as GachaSettingsRow[])[0]
  if (!row) return { ...DEFAULT_GACHA_SETTINGS }

  return {
    isEnabled:
      row.is_enabled === null || row.is_enabled === undefined
        ? DEFAULT_GACHA_SETTINGS.isEnabled
        : Boolean(Number(row.is_enabled)),
    coinsPerLine: numOr(row.coins_per_line, DEFAULT_GACHA_SETTINGS.coinsPerLine),
    maxCoins: numOr(row.max_coins, DEFAULT_GACHA_SETTINGS.maxCoins),
    bonusCoins: numOr(row.bonus_coins, DEFAULT_GACHA_SETTINGS.bonusCoins),
  }
}
