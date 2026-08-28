/**
 * ガチャコインの換算（純関数）。
 *
 * DB にも通信にも触れない。依存の向き（ガチャ → ビンゴ の一方向）を守るため、
 * ライン数からコイン枚数への換算はここ（ガチャ側）に置く。
 * `src/lib/bingo/` からは決して import しない（bingo D-5 / gacha G-4）。
 *
 * 仕様: docs/specs/gacha-and-award/03-coin-lifecycle/earning.md
 */

export interface GachaSettings {
  isEnabled: boolean
  coinsPerLine: number
  maxCoins: number
  bonusCoins: number
}

/**
 * ライン数からコイン獲得枚数へ換算する。
 *
 *   earned = max(0, min(lines * coinsPerLine, maxCoins) + bonusCoins)
 *
 * - `bonusCoins` は上限（`maxCoins`）の外側に足す
 * - 返り値は 0 未満にならない（`bonusCoins` が負の不正データでも 0 で止める）
 * - `lines` について単調非減少（G-2 の前提）
 */
export function calcCoinsEarned(lines: number, s: GachaSettings): number {
  const fromLines = Math.min(lines * s.coinsPerLine, s.maxCoins)
  return Math.max(0, fromLines + s.bonusCoins)
}
