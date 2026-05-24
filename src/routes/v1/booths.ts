import type { FastifyInstance } from 'fastify'
import { sendFail, sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'

export async function boothRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string }; Querystring: { category_id?: string } }>(
    '/events/:event_id/booths',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub
      const cat = req.query.category_id
      const boothParams: string[] = [uid, eventId]
      let catSql = ''
      if (cat) {
        catSql = ' AND b.category_id = ? '
        boothParams.push(cat)
      }
      const [booths] = await app.db.query(
        `SELECT b.id, b.name, b.description, b.manual_code, b.category_id, c.name AS category_name,
          (SELECT COUNT(*) FROM check_ins ci WHERE ci.booth_id = b.id) AS checkin_count,
          (SELECT AVG(br.rating) FROM booth_ratings br WHERE br.booth_id = b.id) AS avg_rating,
          EXISTS(SELECT 1 FROM check_ins ci WHERE ci.booth_id = b.id AND ci.user_id = ?) AS is_checked_in
         FROM booths b
         LEFT JOIN categories c ON c.id = b.category_id
         WHERE b.event_id = ? ${catSql}
         ORDER BY b.name ASC`,
        boothParams,
      )

      const list = booths as {
        id: string
        name: string
        description: string | null
        manual_code: string | null
        category_id: string | null
        category_name: string | null
        checkin_count: number
        avg_rating: string | number | null
        is_checked_in: number | boolean
      }[]

      const ids = list.map((b) => b.id)
      const tagMap = new Map<string, string[]>()
      if (ids.length) {
        const [tags] = await app.db.query(
          `SELECT booth_id, tag FROM booth_tags WHERE booth_id IN (${ids.map(() => '?').join(',')})`,
          ids,
        )
        for (const t of tags as { booth_id: string; tag: string }[]) {
          const arr = tagMap.get(t.booth_id) ?? []
          arr.push(t.tag)
          tagMap.set(t.booth_id, arr)
        }
      }

      return sendOk(reply, {
        booths: list.map((b) => ({
          id: b.id,
          name: b.name,
          manual_code: b.manual_code ?? null,
          description: b.description ?? '',
          category: b.category_id
            ? { id: b.category_id, name: b.category_name ?? '' }
            : null,
          tags: tagMap.get(b.id) ?? [],
          labels: [] as string[],
          checkin_count: Number(b.checkin_count) || 0,
          avg_rating: b.avg_rating != null ? Number(b.avg_rating) : null,
          is_checked_in: Boolean(b.is_checked_in),
        })),
      })
    },
  )

  app.get<{ Params: { event_id: string; booth_id: string } }>(
    '/events/:event_id/booths/:booth_id',
    { preHandler: pre },
    async (req, reply) => {
      const { event_id, booth_id } = req.params
      const uid = req.jwtUser!.sub
      const [rows] = await app.db.query(
        `SELECT b.id, b.name,
          (SELECT COUNT(*) FROM check_ins ci WHERE ci.booth_id = b.id) AS checkin_count_total,
          (SELECT COUNT(*) FROM check_ins ci WHERE ci.booth_id = b.id AND ci.checked_in_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)) AS checkin_count_last_10min,
          (SELECT COUNT(*) FROM check_ins ci WHERE ci.booth_id = b.id AND ci.checked_in_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)) AS checkin_count_last_30min,
          (SELECT AVG(br.rating) FROM booth_ratings br WHERE br.booth_id = b.id) AS avg_rating,
          EXISTS(SELECT 1 FROM check_ins ci WHERE ci.booth_id = b.id AND ci.user_id = ?) AS is_checked_in
         FROM booths b WHERE b.id = ? AND b.event_id = ? LIMIT 1`,
        [uid, booth_id, event_id],
      )
      const b = (rows as Record<string, unknown>[])[0]
      if (!b) {
        return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
      }
      return sendOk(reply, {
        id: b.id,
        name: b.name,
        labels: [] as string[],
        stats: {
          checkin_count_total: Number(b.checkin_count_total) || 0,
          checkin_count_last_10min: Number(b.checkin_count_last_10min) || 0,
          checkin_count_last_30min: Number(b.checkin_count_last_30min) || 0,
          avg_rating: b.avg_rating != null ? Number(b.avg_rating) : null,
          avg_stay_minutes: null as number | null,
        },
        is_checked_in: Boolean(b.is_checked_in),
      })
    },
  )
}
