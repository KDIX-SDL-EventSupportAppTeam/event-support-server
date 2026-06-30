import type { FastifyInstance } from 'fastify'
import { sendOk } from '../../../lib/response.js'
import { requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'

export async function adminRoutes(app: FastifyInstance) {
  const pre = [requireStaff, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/dashboard',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const [r1, r2, r3, r4] = await Promise.all([
        app.db.query('SELECT COUNT(*) AS c FROM users WHERE event_id = ?', [eventId]),
        app.db.query('SELECT COUNT(*) AS c FROM check_ins WHERE event_id = ?', [eventId]),
        app.db.query(
          `SELECT b.id, b.name,
                  COUNT(DISTINCT ci.id) AS checkin_count,
                  AVG(br.rating) AS avg_rating
           FROM booths b
           LEFT JOIN check_ins ci ON ci.booth_id = b.id
           LEFT JOIN booth_ratings br ON br.booth_id = b.id
           WHERE b.event_id = ?
           GROUP BY b.id, b.name
           ORDER BY checkin_count DESC`,
          [eventId],
        ),
        app.db.query(
          `SELECT
             DATE_FORMAT(
               DATE_SUB(checked_in_at, INTERVAL MOD(MINUTE(checked_in_at), 10) MINUTE),
               '%H:%i'
             ) AS time_slot,
             COUNT(*) AS count
           FROM check_ins
           WHERE event_id = ?
           GROUP BY time_slot
           ORDER BY time_slot ASC`,
          [eventId],
        ),
      ])
      const p = Number((r1[0] as { c: number }[])[0]?.c ?? 0)
      const ch = Number((r2[0] as { c: number }[])[0]?.c ?? 0)
      const booths = (r3[0] as {
        id: string
        name: string
        checkin_count: number
        avg_rating: string | number | null
      }[]).map((b) => ({
        id: b.id,
        name: b.name,
        checkin_count: Number(b.checkin_count) || 0,
        avg_rating: b.avg_rating != null ? Number(b.avg_rating) : null,
      }))
      const checkin_timeline = (r4[0] as { time_slot: string; count: number }[]).map((t) => ({
        time_slot: t.time_slot,
        count: Number(t.count) || 0,
      }))
      return sendOk(reply, {
        summary: {
          total_participants: p,
          total_checkins: ch,
          avg_checkins_per_user: p ? Math.round((ch / p) * 10) / 10 : 0,
        },
        booths,
        checkin_timeline,
      })
    },
  )
}
