import type { DbClient } from '../../db/client.js'

/**
 * フォールバック割当。docs/specs/bingo-dynamic-unlock/05-recommender/fallback.md
 *
 * 未訪問ブースから、そのイベントでの訪問者数が少ない順に必要件数を選ぶ。
 * **人気順にしてはならない**（成功の定義と逆行するため）。訪問者数の集計から
 * スタッフ（role<>'participant'）を除外する（E12）。同数は RAND() で散らす。
 *
 * COVERAGE フェーズ（phases.md）はこの規則に「関心分野一致を優先」を足したものだが、
 * strategy の値で区別して記録する（呼び出し側の責務）。
 */

export type FallbackCandidate = { boothId: string; visitors: number }

/**
 * 除外していない有効ブースを、訪問者数が少ない順（同数は RAND）に全件返す。
 * recommendation_scores へ全候補を記録するために「全件」取得できる形にしてある。
 */
export async function listFallbackCandidates(
  db: DbClient,
  eventId: string,
  excludeBoothIds: readonly string[],
): Promise<FallbackCandidate[]> {
  const excludeList = excludeBoothIds.length ? excludeBoothIds : ['']
  const placeholders = excludeList.map(() => '?').join(',')
  const [rows] = await db.query(
    `SELECT b.id, COUNT(u.id) AS visitors
     FROM booths b
     LEFT JOIN check_ins ci ON ci.booth_id = b.id AND ci.event_id = b.event_id
     LEFT JOIN users u ON u.id = ci.user_id AND u.role = 'participant'
     WHERE b.event_id = ? AND b.is_active = 1 AND b.id NOT IN (${placeholders})
     GROUP BY b.id
     ORDER BY visitors ASC, RAND()`,
    [eventId, ...excludeList],
  )
  return (rows as { id: string; visitors: number }[]).map((r) => ({ boothId: r.id, visitors: Number(r.visitors) }))
}

/**
 * すでに取得済みの候補一覧（buildCandidateBooths の結果など）から、
 * `listFallbackCandidates` と同じ規則のフォールバック候補を導出する純関数。
 * SQL 往復を1回減らすために使う（C-5）。
 *
 * **規則は listFallbackCandidates と同一**: 訪問者数の少ない順、同数はランダム。
 * 人気順にしてはならない。
 */
export function deriveFallbackCandidates(
  candidates: readonly { booth_id: string; visitor_count: number }[],
  excludeBoothIds: ReadonlySet<string>,
): FallbackCandidate[] {
  return candidates
    .filter((c) => !excludeBoothIds.has(c.booth_id))
    .map((c) => ({ boothId: c.booth_id, visitors: Number(c.visitor_count ?? 0), r: Math.random() }))
    .sort((a, b) => a.visitors - b.visitors || a.r - b.r)
    .map(({ boothId, visitors }) => ({ boothId, visitors }))
}

/** 全候補の先頭から必要件数のブース id だけを取り出す。 */
export function pickTopFallbackBoothIds(candidates: readonly FallbackCandidate[], limit: number): string[] {
  const safeLimit = Math.max(0, Math.floor(Number(limit)) || 0)
  return candidates.slice(0, safeLimit).map((c) => c.boothId)
}

/** 便宜関数: DB から候補を取得して上位 limit 件のブース id を返す。 */
export async function pickFallbackBoothIds(
  db: DbClient,
  eventId: string,
  excludeBoothIds: readonly string[],
  limit: number,
): Promise<string[]> {
  if (limit <= 0) return []
  const candidates = await listFallbackCandidates(db, eventId, excludeBoothIds)
  return pickTopFallbackBoothIds(candidates, limit)
}
