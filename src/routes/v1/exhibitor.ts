import type { FastifyInstance } from 'fastify'
import { sendFail, sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'
import { assertExhibitorOwnsBooth, getExhibitorBoothIds } from '../../lib/exhibitor.js'
import { commentsQuery, selectBoothComments } from '../../lib/booth-comments.js'

const toIsoDatetime = (v: string): string => `${String(v).replace(' ', 'T')}Z`

/** 評価分布 {1..5: 件数} から平均評価を算出する（評価なしは null）。admin/analytics.ts の avgFromDistribution と同じ計算。 */
function avgFromDistribution(dist: Record<number, number>): number | null {
  let sum = 0
  let count = 0
  for (const star of [1, 2, 3, 4, 5]) {
    const n = dist[star] ?? 0
    sum += star * n
    count += n
  }
  return count > 0 ? Math.round((sum / count) * 100) / 100 : null
}

export async function exhibitorRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

  // 担当ブース一覧（frontend の切替ボタン用。JWT が古くても DB の現在値で判定する）
  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/exhibitor/booths',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const userId = req.jwtUser!.sub

      const { isExhibitor, booths } = await getExhibitorBoothIds(app.db, userId, eventId)
      return sendOk(reply, { is_exhibitor: isExhibitor, booths })
    },
  )

  // 出展者向け集計（担当外・他イベント・非exhibitorはすべて同じ403に潰す。列挙攻撃防止）
  app.get<{ Params: { event_id: string; booth_id: string } }>(
    '/events/:event_id/exhibitor/booths/:booth_id/stats',
    { preHandler: pre },
    async (req, reply) => {
      const { event_id: eventId, booth_id: boothId } = req.params
      const userId = req.jwtUser!.sub

      const booth = await assertExhibitorOwnsBooth(app.db, userId, eventId, boothId)
      if (!booth) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このブースにアクセスできません')
      }

      const [[totalRows], [hourlyRows], [ratingRows], [commentRows]] = await Promise.all([
        app.db.query(
          'SELECT COUNT(*) AS c FROM check_ins WHERE booth_id = ? AND event_id = ?',
          [boothId, eventId],
        ),
        app.db.query(
          `SELECT DATE_FORMAT(checked_in_at, '%H:00') AS time_slot, COUNT(*) AS count
           FROM check_ins WHERE booth_id = ? AND event_id = ?
           GROUP BY time_slot ORDER BY time_slot ASC`,
          [boothId, eventId],
        ),
        app.db.query(
          `SELECT rating, COUNT(*) AS cnt FROM booth_ratings
           WHERE booth_id = ? AND event_id = ? GROUP BY rating`,
          [boothId, eventId],
        ),
        app.db.query(
          `SELECT id, rating, comment, rated_at FROM booth_ratings
           WHERE booth_id = ? AND event_id = ?
             AND comment IS NOT NULL AND comment <> '' AND is_hidden = 0
           ORDER BY rated_at DESC
           LIMIT 20`,
          [boothId, eventId],
        ),
      ])

      const totalCheckins = Number((totalRows as { c: number | string }[])[0]?.c) || 0

      const hourlyCheckins = (hourlyRows as { time_slot: string; count: number | string }[]).map(
        (r) => ({ time_slot: r.time_slot, count: Number(r.count) || 0 }),
      )

      const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
      let ratingCount = 0
      for (const r of ratingRows as { rating: number; cnt: number | string }[]) {
        const cnt = Number(r.cnt) || 0
        distribution[r.rating as 1 | 2 | 3 | 4 | 5] = cnt
        ratingCount += cnt
      }

      const comments = (commentRows as {
        id: string
        rating: number
        comment: string
        rated_at: string
      }[]).map((c) => ({
        id: c.id,
        rating: c.rating,
        comment: c.comment,
        rated_at: toIsoDatetime(c.rated_at),
      }))

      return sendOk(reply, {
        booth,
        total_checkins: totalCheckins,
        hourly_checkins: hourlyCheckins,
        ratings: {
          count: ratingCount,
          avg_rating: avgFromDistribution(distribution),
          distribution,
        },
        comments,
      })
    },
  )

  // 出展者向けコメント一覧（自ブース限定・is_hidden=0のみ・匿名。運営向けは admin/booth-comments.ts）
  app.get<{
    Params: { event_id: string; booth_id: string }
    Querystring: Record<string, string>
  }>(
    '/events/:event_id/exhibitor/booths/:booth_id/comments',
    { preHandler: pre },
    async (req, reply) => {
      const { event_id: eventId, booth_id: boothId } = req.params
      const userId = req.jwtUser!.sub

      const booth = await assertExhibitorOwnsBooth(app.db, userId, eventId, boothId)
      if (!booth) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このブースのコメントを閲覧する権限がありません')
      }

      const parsedQuery = commentsQuery.safeParse(req.query)
      const { limit, offset } = parsedQuery.success ? parsedQuery.data : { limit: 20, offset: 0 }

      const { rows, total } = await selectBoothComments(app.db, eventId, boothId, limit, offset, false)

      return sendOk(reply, {
        booth,
        comments: rows.map((r) => ({
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          rated_at: toIsoDatetime(r.rated_at),
        })),
        pagination: { limit, offset, total, has_more: offset + rows.length < total },
      })
    },
  )
}
