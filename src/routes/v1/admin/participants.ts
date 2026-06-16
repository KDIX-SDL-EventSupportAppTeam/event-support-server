import type { FastifyInstance } from 'fastify'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireAdmin, requireEventMatchesJwt } from '../../../plugins/auth.js'

export async function adminParticipantRoutes(app: FastifyInstance) {
  const pre = [requireAdmin, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/participants',
    { preHandler: pre },
    async (req, reply) => {
      const [rows] = await app.db.query(
        `SELECT u.id, u.display_name, u.email, u.created_at,
                COUNT(ci.id) AS checkin_count
         FROM users u
         LEFT JOIN check_ins ci ON ci.user_id = u.id
         WHERE u.event_id = ? AND u.role = 'participant'
         GROUP BY u.id, u.display_name, u.email, u.created_at
         ORDER BY u.created_at DESC`,
        [req.params.event_id],
      )
      return sendOk(reply, {
        participants: (rows as {
          id: string
          display_name: string | null
          email: string
          created_at: string
          checkin_count: number
        }[]).map((r) => ({
          id: r.id,
          display_name: r.display_name ?? '',
          email: r.email,
          checkin_count: Number(r.checkin_count) || 0,
          created_at: `${String(r.created_at).replace(' ', 'T')}Z`,
        })),
      })
    },
  )

  app.delete<{ Params: { event_id: string; user_id: string } }>(
    '/admin/events/:event_id/participants/:user_id',
    { preHandler: pre },
    async (req, reply) => {
      const [result] = await app.db.execute(
        `DELETE FROM users WHERE id = ? AND event_id = ? AND role = 'participant'`,
        [req.params.user_id, req.params.event_id],
      )
      const affected = (result as { affectedRows?: number }).affectedRows ?? 0
      if (!affected) {
        return sendFail(reply, 404, 'NOT_FOUND', '参加者が見つかりません')
      }
      return sendOk(reply, { deleted: true })
    },
  )
}
