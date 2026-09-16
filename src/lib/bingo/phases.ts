/**
 * 推薦フェーズの判定（純関数。DB を触らない）。
 * docs/specs/bingo-dynamic-unlock/05-recommender/phases.md
 *
 * アルゴリズム本体（COVERAGE/SIMILARITY/DRSA の実装）は推薦エンジン側の関心事であり、
 * 通常はレスポンスの `phase` をそのまま記録する。この関数は、
 * - 推薦サービス未設定・フォールバック時に記録する phase を決めるため
 * - しきい値の境界を純関数として固定テストするため（10-testing/unit-coverage.md）
 * にサーバー側にも用意する。
 */

export type RecommendPhase = 'COVERAGE' | 'SIMILARITY' | 'DRSA'

export type PhaseThresholds = {
  /** この件数未満なら COVERAGE */
  similarityMin: number
  /** この件数以上なら DRSA */
  drsaMin: number
}

export const DEFAULT_PHASE_THRESHOLDS: PhaseThresholds = {
  similarityMin: 30,
  drsaMin: 180,
}

/**
 * 決定表の件数（評価付きペア数）からフェーズを判定する。
 * 0件・負数でも例外を投げず COVERAGE を返す。
 */
export function determinePhase(
  decisionTableSize: number,
  thresholds: PhaseThresholds = DEFAULT_PHASE_THRESHOLDS,
): RecommendPhase {
  const size = Number.isFinite(decisionTableSize) && decisionTableSize > 0 ? decisionTableSize : 0
  if (size >= thresholds.drsaMin) return 'DRSA'
  if (size >= thresholds.similarityMin) return 'SIMILARITY'
  return 'COVERAGE'
}
