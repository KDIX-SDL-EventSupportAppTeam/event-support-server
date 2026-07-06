import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sendOk } from '../../../lib/response.js'
import { requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

type AuditLogRow = {
  id: string
  event_id: string
  actor_id: string
  actor_role: string
  action: string
  target_type: string
  target_id: string | null
  detail: string | unknown
  created_at: string
  actor_display_name: string | null
  actor_email: string | null
}

export async function adminAuditLogRoutes(app: FastifyInstance) {
  const pre = [requireStaff, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string }; Querystring: Record<string, string> }>(
    '/admin/events/:event_id/audit-logs',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = querySchema.safeParse(req.query)
      const { page, limit } = parsed.success ? parsed.data : { page: 1, limit: 50 }
      const offset = (page - 1) * limit

      const [countRows] = await app.db.query(
        'SELECT COUNT(*) AS total FROM audit_logs WHERE event_id = ?',
        [req.params.event_id],
      )
      const total = Number((countRows as { total: number }[])[0]?.total ?? 0)

      const [rows] = await app.db.query(
        `SELECT al.id, al.event_id, al.actor_id, al.actor_role, al.action,
                al.target_type, al.target_id, al.detail, al.created_at,
                u.display_name AS actor_display_name, u.email AS actor_email
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.actor_id AND u.event_id = al.event_id
         WHERE al.event_id = ?
         ORDER BY al.created_at DESC
         LIMIT ? OFFSET ?`,
        [req.params.event_id, limit, offset],
      )

      return sendOk(reply, {
        audit_logs: (rows as AuditLogRow[]).map((r) => ({
          id: r.id,
          event_id: r.event_id,
          actor_id: r.actor_id,
          actor_role: r.actor_role,
          actor_display_name: r.actor_display_name ?? null,
          actor_email: r.actor_email ?? null,
          action: r.action,
          target_type: r.target_type,
          target_id: r.target_id ?? null,
          detail: typeof r.detail === 'string' ? (JSON.parse(r.detail) as unknown) : r.detail,
          created_at: `${String(r.created_at).replace(' ', 'T')}Z`,
        })),
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
        },
      })
    },
  )
}
