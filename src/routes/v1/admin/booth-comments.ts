import type { FastifyInstance } from 'fastify'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { commentsQuery, selectBoothComments } from '../../../lib/booth-comments.js'

const toIsoDatetime = (v: string): string => `${String(v).replace(' ', 'T')}Z`

/** 運営向けコメント一覧（全ブース対象・is_hidden含む全件・表示名あり）。#55 の運営コメントUIもこのAPIを使う。 */
export async function adminBoothCommentRoutes(app: FastifyInstance) {
  const pre = [requireStaff, requireEventMatchesJwt]

  app.get<{
    Params: { event_id: string; booth_id: string }
    Querystring: Record<string, string>
  }>(
    '/admin/events/:event_id/booths/:booth_id/comments',
    { preHandler: pre },
    async (req, reply) => {
      const { event_id: eventId, booth_id: boothId } = req.params

      const [bRows] = await app.db.query(
        'SELECT id, name FROM booths WHERE id = ? AND event_id = ? LIMIT 1',
        [boothId, eventId],
      )
      const booth = (bRows as { id: string; name: string }[])[0]
      if (!booth) {
        return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
      }

      const parsedQuery = commentsQuery.safeParse(req.query)
      const { limit, offset } = parsedQuery.success ? parsedQuery.data : { limit: 20, offset: 0 }

      const { rows, total } = await selectBoothComments(app.db, eventId, boothId, limit, offset, true)

      return sendOk(reply, {
        booth,
        comments: rows.map((r) => ({
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          is_hidden: Boolean(r.is_hidden),
          user_display_name: r.user_display_name,
          rated_at: toIsoDatetime(r.rated_at),
        })),
        pagination: { limit, offset, total, has_more: offset + rows.length < total },
      })
    },
  )
}
