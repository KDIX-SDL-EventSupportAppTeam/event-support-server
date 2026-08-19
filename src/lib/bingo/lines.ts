/**
 * ライン成立とガチャコイン判定（純関数。DB を触らない）。
 * docs/.sdd/03-card-lifecycle/lines-and-coins.md
 */

/** 4x4 の全10ライン（4行 + 4列 + 2対角）。position は行優先 0..15。 */
export const LINES: readonly (readonly number[])[] = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [8, 9, 10, 11],
  [12, 13, 14, 15], // 行
  [0, 4, 8, 12],
  [1, 5, 9, 13],
  [2, 6, 10, 14],
  [3, 7, 11, 15], // 列
  [0, 5, 10, 15],
  [3, 6, 9, 12], // 対角
]

export const MAX_COINS = 4

/** 達成済み position の集合から、成立しているライン数を返す。 */
export function countCompletedLines(achieved: ReadonlySet<number>): number {
  let count = 0
  for (const line of LINES) {
    if (line.every((pos) => achieved.has(pos))) {
      count += 1
    }
  }
  return count
}

/** 成立ライン総数を 4 でクリップした値。差分加算にしない（二重加算防止）。 */
export function calcCoinsEarned(achieved: ReadonlySet<number>): number {
  return Math.min(countCompletedLines(achieved), MAX_COINS)
}
