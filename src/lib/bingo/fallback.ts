import type { DbClient } from '../../db/client.js'

/**
 * フォールバック割当。docs/.sdd/05-recommender/fallback.md
 *
 * 未訪問ブースから、そのイベントでの訪問者数が少ない順に必要件数を選ぶ。
 * 人気順にしてはならない（成功の定義と逆行するため）。訪問者数の集計から
 * スタッフ（role<>'participant'）を除外する（E11）。同数は RAND() で散らす。
 */
export async function pickFallbackBoothIds(
  db: DbClient,
  eventId: string,
  excludeBoothIds: string[],
  limit: number,
): Promise<string[]> {
  if (limit <= 0) return []
  const excludeList = excludeBoothIds.length ? excludeBoothIds : ['']
  const placeholders = excludeList.map(() => '?').join(',')
  // LIMIT はプロキシ経由のパラメータバインドで問題が出た既存例があるため、
  // 整数であることを検証したうえで直接埋め込む（SQLインジェクションのリスクはない）。
  const safeLimit = Math.max(0, Math.floor(Number(limit)) || 0)
  const [rows] = await db.query(
    `SELECT b.id, COUNT(ci.id) AS visitors
     FROM booths b
     LEFT JOIN check_ins ci ON ci.booth_id = b.id AND ci.event_id = b.event_id
     LEFT JOIN users u ON u.id = ci.user_id AND u.role = 'participant'
     WHERE b.event_id = ? AND b.is_active = 1 AND b.id NOT IN (${placeholders})
     GROUP BY b.id
     ORDER BY visitors ASC, RAND()
     LIMIT ${safeLimit}`,
    [eventId, ...excludeList],
  )
  return (rows as { id: string }[]).map((r) => r.id)
}
