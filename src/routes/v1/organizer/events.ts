import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { signAccessToken } from '../../../lib/jwt.js'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireOrganizer } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'
import { buildEventUrls } from '../../../lib/url.js'

const createEventBody = z.object({
  name: z.string().min(1).max(255),
  date_start: z.string().min(1),
  date_end: z.string().min(1),
  venue: z.string().max(500).optional(),
  initial_manager: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
    display_name: z.string().min(1).max(200).optional(),
  }),
})

export async function organizerEventRoutes(app: FastifyInstance) {
  const pre = [requireOrganizer]

  // Phase 2 stub: list events owned by this organizer
  app.get(
    '/organizer/events',
    { preHandler: pre },
    async (_req, reply) => {
      // TODO: Phase 2 でオーガナイザーが所有するイベント一覧を返す実装を追加する
      return sendOk(reply, { events: [] })
    },
  )

  app.post(
    '/organizer/events',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = createEventBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data
      const organizerId = req.organizerUser!.sub

      const eventId = randomUUID()
      const managerId = randomUUID()
      const managerHash = await bcrypt.hash(body.initial_manager.password, 10)
      const managerDisplayName = body.initial_manager.display_name ?? body.initial_manager.email
      const managerEmail = body.initial_manager.email.toLowerCase()

      const conn = await app.db.getConnection?.()

      if (conn) {
        // トランザクション対応（接続プールが getConnection をサポートする場合）
        try {
          await conn.beginTransaction()

          await conn.execute(
            'INSERT INTO events (id, organizer_id, name, date_start, date_end, venue) VALUES (?,?,?,?,?,?)',
            [eventId, organizerId, body.name, body.date_start, body.date_end, body.venue ?? null],
          )

          await conn.execute(
            'INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)',
            [managerId, eventId, managerEmail, managerHash, managerDisplayName, 'manager'],
          )

          await conn.execute(
            `INSERT INTO audit_logs (id, event_id, actor_id, actor_role, action, target_type, target_id, detail)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              randomUUID(),
              eventId,
              organizerId,
              'organizer',
              'staff.invite',
              'user',
              managerId,
              JSON.stringify({ email: managerEmail, role: 'manager' }),
            ],
          )

          await conn.commit()
        } catch (e) {
          await conn.rollback()
          throw e
        } finally {
          conn.release()
        }
      } else {
        // getConnection 非対応の場合は順次実行し、失敗時は補償削除する（さくらプロキシ環境等）
        await app.db.execute(
          'INSERT INTO events (id, organizer_id, name, date_start, date_end, venue) VALUES (?,?,?,?,?,?)',
          [eventId, organizerId, body.name, body.date_start, body.date_end, body.venue ?? null],
        )

        try {
          await app.db.execute(
            'INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)',
            [managerId, eventId, managerEmail, managerHash, managerDisplayName, 'manager'],
          )

          await insertAuditLog(app.db, {
            eventId,
            actorId: organizerId,
            actorRole: 'organizer',
            action: 'staff.invite',
            targetType: 'user',
            targetId: managerId,
            detail: { email: managerEmail, role: 'manager' },
          })
        } catch (e) {
          // ON DELETE CASCADE により events に紐づく中間データも削除される
          await app.db.execute('DELETE FROM events WHERE id = ?', [eventId])
          throw e
        }
      }

      const [eventRows] = await app.db.query(
        'SELECT id, name, date_start, date_end, venue FROM events WHERE id = ? LIMIT 1',
        [eventId],
      )
      const event = (eventRows as {
        id: string
        name: string
        date_start: string
        date_end: string
        venue: string | null
      }[])[0]

      const token = await signAccessToken(
        app.db,
        app.config.jwtSecret,
        managerId,
        eventId,
        managerDisplayName,
        'manager',
      )

      const urls = buildEventUrls(app.config, eventId)

      return sendOk(
        reply,
        {
          event,
          initial_manager: {
            id: managerId,
            email: managerEmail,
            display_name: managerDisplayName,
            token,
          },
          urls,
        },
        201,
      )
    },
  )
}
