/**
 * ライン判定（純関数。DB を触らない）。
 * docs/specs/bingo-dynamic-unlock/03-card-lifecycle/lines.md
 *
 * ビンゴ側が計算するのは成立ライン数までである（D-5）。コインへの換算はガチャ側の責務。
 * calcCoinsEarned() / MAX_COINS はここには置かない。
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

/**
 * 達成済み position の集合から、成立しているライン数を返す。
 * 中央2x2 {5,6,9,10} はどのラインにも含まれないため、中央4マス達成だけでは 0 のままである。
 * 達成した順序には依存しない（集合だけで決まる）。
 */
export function countCompletedLines(achieved: ReadonlySet<number>): number {
  let count = 0
  for (const line of LINES) {
    if (line.every((pos) => achieved.has(pos))) {
      count += 1
    }
  }
  return count
}

/** 成立しているライン index の一覧を返す（順序は LINES の並びに従う）。 */
export function completedLineIndexes(achieved: ReadonlySet<number>): number[] {
  const out: number[] = []
  LINES.forEach((line, idx) => {
    if (line.every((pos) => achieved.has(pos))) out.push(idx)
  })
  return out
}
