import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireOrganizer } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'

const inviteStaffBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  display_name: z.string().min(1).max(200).optional(),
  role: z.enum(['manager', 'viewer']),
})

export async function organizerStaffRoutes(app: FastifyInstance) {
  const pre = [requireOrganizer]

  app.post<{ Params: { event_id: string } }>(
    '/organizer/events/:event_id/staff',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = inviteStaffBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data
      const { event_id } = req.params
      const organizerId = req.organizerUser!.sub

      // オーガナイザーがこのイベントを所有しているか確認
      const [evRows] = await app.db.query(
        'SELECT id FROM events WHERE id = ? AND organizer_id = ? LIMIT 1',
        [event_id, organizerId],
      )
      if (!(evRows as { id: string }[])[0]) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このイベントへのアクセス権限がありません')
      }

      const email = body.email.toLowerCase()
      const [dup] = await app.db.query(
        'SELECT id FROM users WHERE event_id = ? AND email = ? LIMIT 1',
        [event_id, email],
      )
      if ((dup as { id: string }[])[0]) {
        return sendFail(reply, 409, 'CONFLICT', 'このメールアドレスは既に登録されています')
      }

      const id = randomUUID()
      const hash = await bcrypt.hash(body.password, 10)
      const displayName = body.display_name ?? email

      try {
        await app.db.execute(
          'INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)',
          [id, event_id, email, hash, displayName, body.role],
        )
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === 'ER_DUP_ENTRY') {
          return sendFail(reply, 409, 'CONFLICT', 'このメールアドレスは既に登録されています')
        }
        throw e
      }

      await insertAuditLog(app.db, {
        eventId: event_id,
        actorId: organizerId,
        actorRole: 'organizer',
        action: 'staff.invite',
        targetType: 'user',
        targetId: id,
        detail: { email, role: body.role },
      })

      return sendOk(
        reply,
        { staff: { id, email, display_name: displayName, role: body.role } },
        201,
      )
    },
  )
}
