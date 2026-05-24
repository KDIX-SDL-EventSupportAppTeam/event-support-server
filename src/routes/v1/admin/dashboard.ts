import type { FastifyInstance } from 'fastify'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireBearerAuth } from '../../../plugins/auth.js'

export async function adminRoutes(app: FastifyInstance) {
  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/dashboard',
    { preHandler: [requireBearerAuth] },
    async (req, reply) => {
      if (req.jwtUser!.role !== 'admin') {
        return sendFail(reply, 403, 'FORBIDDEN', '運営権限が必要です')
      }
      const eventId = req.params.event_id
      if (req.jwtUser!.event_id !== eventId) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このイベントにアクセスできません')
      }
      const [r1, r2] = await Promise.all([
        app.db.query('SELECT COUNT(*) AS c FROM users WHERE event_id = ?', [eventId]),
        app.db.query('SELECT COUNT(*) AS c FROM check_ins WHERE event_id = ?', [eventId]),
      ])
      const p = Number((r1[0] as { c: number }[])[0]?.c ?? 0)
      const ch = Number((r2[0] as { c: number }[])[0]?.c ?? 0)
      return sendOk(reply, {
        summary: {
          total_participants: p,
          total_checkins: ch,
          avg_checkins_per_user: p ? Math.round((ch / p) * 10) / 10 : 0,
        },
        booths: [] as unknown[],
        checkin_timeline: [] as unknown[],
      })
    },
  )
}
