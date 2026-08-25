import type { AppConfig } from '../../config.js'

/**
 * 推薦サービス（event-support-recommender）との HTTP 契約。
 * docs/specs/bingo-dynamic-unlock/05-recommender/contract.md が正本。
 *
 * サーバー側は呼び出し口とフォールバックだけを持つ。アルゴリズム本体は推薦エンジン側の関心事。
 * RECOMMENDER_URL 未設定・空文字なら呼び出さず即フォールバックする。
 * 失敗・タイムアウトも例外を投げず null を返す（解放そのものは必ず成功させる）。
 */

export type VisitedBoothPayload = {
  booth_id: string
  order: number
  source: 'PRESURVEY' | 'FREE_VISIT'
  rating: number | null
  rating_scale: number
}

export type CandidateBoothPayload = {
  booth_id: string
  category_id: string | null
  visitor_count: number
}

export type RecommendCellsRequest = {
  event_id: string
  user_id: string
  cell_count: number
  visited_booths: VisitedBoothPayload[]
  pre_survey: Record<string, unknown> | null
  exclude_booth_ids: string[]
  candidate_booths: CandidateBoothPayload[]
}

export type InterestMatch = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'UNKNOWN'

export type RecommendScore = {
  booth_id: string
  score: number | null
  rank: number | null
  interest_match: InterestMatch
  attributes: unknown
  reason: unknown
}

export type RecommendAssigned = {
  booth_id: string
  score: number | null
  rank: number | null
}

export type RecommendCellsResponse = {
  phase: string
  decisionTableSize: number | null
  assigned: RecommendAssigned[]
  scores: RecommendScore[]
}

/**
 * POST {RECOMMENDER_URL}/recommend/cells を呼ぶ。
 * タイムアウト（既定 RECOMMENDER_TIMEOUT_MS=1000）で AbortController により中断する。
 * 応答を検証せずに DB へ書かないこと（呼び出し側=assignOuterCells.ts の責務）。
 */
export async function callRecommender(
  config: AppConfig,
  req: RecommendCellsRequest,
): Promise<RecommendCellsResponse | null> {
  const baseUrl = config.recommenderUrl.trim()
  if (!baseUrl) return null

  const url = `${baseUrl.replace(/\/+$/, '')}/recommend/cells`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.recommenderTimeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    return parseRecommendResponse(body)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function parseRecommendResponse(v: unknown): RecommendCellsResponse | null {
  if (!v || typeof v !== 'object') return null
  const obj = v as Record<string, unknown>

  const phase = typeof obj.phase === 'string' && obj.phase ? obj.phase : 'UNKNOWN'
  const decisionTableSize = typeof obj.decision_table_size === 'number' ? obj.decision_table_size : null

  const assignedRaw = obj.assigned
  const assigned: RecommendAssigned[] = Array.isArray(assignedRaw)
    ? assignedRaw
        .map((c) => parseAssigned(c))
        .filter((c): c is RecommendAssigned => c !== null)
    : []

  const scoresRaw = obj.scores
  const scores: RecommendScore[] = Array.isArray(scoresRaw)
    ? scoresRaw.map((c) => parseScore(c)).filter((c): c is RecommendScore => c !== null)
    : []

  return { phase, decisionTableSize, assigned, scores }
}

function parseAssigned(v: unknown): RecommendAssigned | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const boothId = o.booth_id
  if (typeof boothId !== 'string' || !boothId) return null
  const score = typeof o.score === 'number' ? o.score : null
  const rank = typeof o.rank === 'number' ? o.rank : null
  return { booth_id: boothId, score, rank }
}

const INTEREST_MATCH_VALUES: InterestMatch[] = ['MATCH', 'PARTIAL', 'MISMATCH', 'UNKNOWN']

function parseScore(v: unknown): RecommendScore | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const boothId = o.booth_id
  if (typeof boothId !== 'string' || !boothId) return null
  const score = typeof o.score === 'number' ? o.score : null
  const rank = typeof o.rank === 'number' ? o.rank : null
  const interestMatchRaw = o.interest_match
  const interest_match: InterestMatch = INTEREST_MATCH_VALUES.includes(interestMatchRaw as InterestMatch)
    ? (interestMatchRaw as InterestMatch)
    : 'UNKNOWN'
  const attributes = o.attributes ?? null
  const reason = o.reason ?? null
  return { booth_id: boothId, score, rank, interest_match, attributes, reason }
}
