import { z } from 'zod'
import type { DbClient } from '../db/client.js'

/** limit/offset のページネーション（両GET共通）。パース失敗時は audit-logs.ts の流儀に合わせ既定値へフォールバックする（呼び出し側で行う）。 */
export const commentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

export type BoothCommentRow = {
  id: string
  rating: number
  comment: string
  is_hidden: number // 0/1（呼び出し側で Boolean() 変換 or 出展者向けでは捨てる）
  user_display_name: string | null
  rated_at: string
}

/**
 * ブースのコメント一覧を「rated_at 降順・limit/offset」で返す共通SELECT。
 * 出展者向けGET・運営向けGETの両方から呼ばれる（認可はハンドラ側の責務。ここはクエリのみ）。
 *
 * includeHidden=false のとき COUNT・本体SELECT の両方の WHERE に `AND is_hidden = 0` を足す
 * （pagination の total/has_more を is_hidden=0 の件数だけで正しく保つため）。
 * includeHidden=true のときは is_hidden によるフィルタを行わない。
 */
export async function selectBoothComments(
  db: DbClient,
  eventId: string,
  boothId: string,
  limit: number,
  offset: number,
  includeHidden: boolean,
): Promise<{ rows: BoothCommentRow[]; total: number }> {
  const hiddenFilter = includeHidden ? '' : ' AND is_hidden = 0'

  // LIMIT / OFFSET はプレースホルダにせず、検証済み整数を直接埋め込む。
  // さくらプロキシ（プリペアドステートメント経路）では LIMIT のバインドが失敗して
  // 500 になるため（audit-logs #63 と同じ地雷）。呼び出し側は commentsQuery
  // （zod int/min/max）を通した値を渡すが、共有ライブラリなので念のため整数へクランプする。
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 1, 1), 50)
  const safeOffset = Math.max(Math.trunc(offset) || 0, 0)

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM booth_ratings
     WHERE event_id = ? AND booth_id = ? AND comment IS NOT NULL${hiddenFilter}`,
    [eventId, boothId],
  )
  const [rows] = await db.query(
    `SELECT br.id, br.rating, br.comment, br.is_hidden, br.rated_at,
            u.display_name AS user_display_name
     FROM booth_ratings br
     LEFT JOIN users u ON u.id = br.user_id
     WHERE br.event_id = ? AND br.booth_id = ? AND br.comment IS NOT NULL${hiddenFilter}
     ORDER BY br.rated_at DESC, br.id DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [eventId, boothId],
  )
  return {
    rows: rows as BoothCommentRow[],
    total: Number((countRows as { total: number }[])[0]?.total ?? 0),
  }
}
