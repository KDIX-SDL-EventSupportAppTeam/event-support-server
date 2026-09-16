/**
 * 中央ペアと解放される列の対応表（純関数。DB・通信を一切触らない）。
 * docs/specs/bingo-dynamic-unlock/03-card-lifecycle/unlock-pairs.md
 *
 * 本機能の中核となる定義。中央マスは position {5, 6, 9, 10}。そこから2つ選ぶ組は6通りで、
 * それぞれがちょうど1本のビンゴ列（LINES）に対応し、そのラインの残り2マスが外周マスになる。
 * 6組 × 2マス = 外周12マス（過不足なし）。
 */

/** 中央2x2 の position（行優先 0..15）。glossary.md: 議事録の {6,7,10,11} = コードの {5,6,9,10}。 */
export const CENTER_POSITIONS: readonly number[] = [5, 6, 9, 10]
export const OUTER_POSITIONS: readonly number[] = Array.from({ length: 16 }, (_, i) => i).filter(
  (p) => !CENTER_POSITIONS.includes(p),
)

export type PairKey = '5-6' | '9-10' | '5-9' | '6-10' | '5-10' | '6-9'

export type PairDefinition = {
  pairKey: PairKey
  centerPositions: readonly [number, number]
  lineIndex: number
  releasedPositions: readonly [number, number]
}

/**
 * 対応表（これがすべて）。unlock-pairs.md の6行をそのままデータ化したもの。
 * pair_key は小さい position を先にしたハイフン区切り。この6値以外は存在しない。
 */
export const PAIR_TABLE: readonly PairDefinition[] = [
  { pairKey: '5-6', centerPositions: [5, 6], lineIndex: 1, releasedPositions: [4, 7] },
  { pairKey: '9-10', centerPositions: [9, 10], lineIndex: 2, releasedPositions: [8, 11] },
  { pairKey: '5-9', centerPositions: [5, 9], lineIndex: 5, releasedPositions: [1, 13] },
  { pairKey: '6-10', centerPositions: [6, 10], lineIndex: 6, releasedPositions: [2, 14] },
  { pairKey: '5-10', centerPositions: [5, 10], lineIndex: 8, releasedPositions: [0, 15] },
  { pairKey: '6-9', centerPositions: [6, 9], lineIndex: 9, releasedPositions: [3, 12] },
]

const PAIR_BY_KEY: ReadonlyMap<PairKey, PairDefinition> = new Map(PAIR_TABLE.map((p) => [p.pairKey, p]))

export function pairKeyOf(a: number, b: number): PairKey {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return `${lo}-${hi}` as PairKey
}

export function pairDefinitionByKey(key: string): PairDefinition | undefined {
  return PAIR_BY_KEY.get(key as PairKey)
}

/**
 * 達成済みの中央 position の集合から、その時点で成立しているペアの一覧を返す。
 * DB にも通信にも触れない純関数。
 */
export function getSatisfiedPairs(achievedCenter: ReadonlySet<number>): PairDefinition[] {
  return PAIR_TABLE.filter((p) => p.centerPositions.every((pos) => achievedCenter.has(pos)))
}

/**
 * 「すでに解放済みのペア」との差分を取り、新規に成立したペアだけを返す。
 * 同じペアが二度処理されないようにするための純関数（最終防衛線は
 * card_unlock_events の UNIQUE (card_id, pair_key)）。
 */
export function diffNewPairs(
  satisfiedPairs: readonly PairDefinition[],
  alreadyUnlockedKeys: ReadonlySet<string>,
): PairDefinition[] {
  return satisfiedPairs.filter((p) => !alreadyUnlockedKeys.has(p.pairKey))
}

/**
 * getSatisfiedPairs + diffNewPairs をまとめたヘルパー。
 * 「達成済みの中央 position の集合」と「解放済みのペアキーの集合」から、新規ペアだけを返す。
 */
export function computeNewlyCompletedPairs(
  achievedCenter: ReadonlySet<number>,
  alreadyUnlockedKeys: ReadonlySet<string>,
): PairDefinition[] {
  return diffNewPairs(getSatisfiedPairs(achievedCenter), alreadyUnlockedKeys)
}
