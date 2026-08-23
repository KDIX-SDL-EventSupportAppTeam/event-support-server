import type { AppConfig } from '../../config.js'

/**
 * 推薦サービス（Python FastAPI）との契約。docs/.sdd/05-recommender/contract.md
 *
 * TODO(Q-3): 外側12マスの割当アルゴリズム本体は本仕様書のスコープ外。
 * ここは呼び出し口のみで、アルゴリズムは実装しない。RECOMMENDER_URL 未設定・
 * 空文字なら呼び出さず即フォールバックする。失敗・タイムアウトも例外を投げず null を返す。
 */

export type VisitedBooth = {
  booth_id: string
  order: number
  source: 'SIGNUP_BONUS' | 'FREE_VISIT'
  rating: number | null
}

export type RecommendRequest = {
  event_id: string
  user_id: string
  visited_booths: VisitedBooth[]
  rating_scale: number
  pre_survey: Record<string, unknown> | null
  exclude_booth_ids: string[]
  cell_count: number
}

export type RecommendCell = {
  booth_id: string
  strategy: string
  score: number | null
  reason: unknown
}

export async function callRecommender(
  config: AppConfig,
  req: RecommendRequest,
): Promise<RecommendCell[] | null> {
  const baseUrl = config.recommenderUrl.trim()
  if (!baseUrl) return null

  const url = `${baseUrl.replace(/\/+$/, '')}/recommend/outer-cells`
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

function parseRecommendResponse(v: unknown): RecommendCell[] | null {
  if (!v || typeof v !== 'object') return null
  const cells = (v as Record<string, unknown>).cells
  if (!Array.isArray(cells)) return null
  const out: RecommendCell[] = []
  for (const c of cells) {
    if (!c || typeof c !== 'object') continue
    const boothId = (c as Record<string, unknown>).booth_id
    if (typeof boothId !== 'string' || !boothId) continue
    const strategyRaw = (c as Record<string, unknown>).strategy
    // strategy は VARCHAR として値を検証せずそのまま保存する（Q-3/Q-5）
    const strategy = typeof strategyRaw === 'string' && strategyRaw ? strategyRaw : 'UNKNOWN'
    const scoreRaw = (c as Record<string, unknown>).score
    const score = typeof scoreRaw === 'number' ? scoreRaw : null
    const reason = (c as Record<string, unknown>).reason ?? null
    out.push({ booth_id: boothId, strategy, score, reason })
  }
  return out
}
