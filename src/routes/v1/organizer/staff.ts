import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireOrganizer } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'
import { assertEventOwnedByOrganizer } from '../../../lib/organizer.js'

const inviteStaffBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  display_name: z.string().min(1).max(200).optional(),
  role: z.enum(['manager', 'viewer']),
})

const patchStaffBody = z.object({
  role: z.enum(['manager', 'viewer']),
})

/** DB の users 行（スタッフ）。 */
type StaffRow = {
  id: string
  email: string
  display_name: string | null
  role: string
  created_at: string
}

/** 旧 admin ロールは manager と同等に扱い、display_name の null は '' に正規化する。 */
function toStaffPayload(row: StaffRow) {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name ?? '',
    role: row.role === 'admin' ? 'manager' : row.role,
    created_at: `${String(row.created_at).replace(' ', 'T')}Z`,
  }
}

/**
 * 対象イベントの manager（旧 admin 含む）が、指定ユーザーを除いて 0 人かを返す。
 * 「最後の管理者」ガードの判定に使う。
 */
async function isLastManager(
  app: FastifyInstance,
  eventId: string,
  excludeUserId: string,
): Promise<boolean> {
  const [rows] = await app.db.query(
    `SELECT COUNT(*) AS c FROM users
     WHERE event_id = ? AND role IN ('manager','admin') AND id != ?`,
    [eventId, excludeUserId],
  )
  const others = Number((rows as { c: number | string }[])[0]?.c ?? 0)
  return others === 0
}

export async function organizerStaffRoutes(app: FastifyInstance) {
  const pre = [requireOrganizer]

  // スタッフ招待（Phase 1）
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

      if (!(await assertEventOwnedByOrganizer(app.db, event_id, organizerId))) {
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

  // スタッフ一覧（role != 'participant'、招待順）
  app.get<{ Params: { event_id: string } }>(
    '/organizer/events/:event_id/staff',
    { preHandler: pre },
    async (req, reply) => {
      const { event_id } = req.params
      const organizerId = req.organizerUser!.sub

      if (!(await assertEventOwnedByOrganizer(app.db, event_id, organizerId))) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このイベントへのアクセス権限がありません')
      }

      const [rows] = await app.db.query(
        `SELECT id, email, display_name, role, created_at
         FROM users WHERE event_id = ? AND role != 'participant'
         ORDER BY created_at ASC`,
        [event_id],
      )
      return sendOk(reply, {
        staff: (rows as StaffRow[]).map(toStaffPayload),
      })
    },
  )

  // ロール変更（最後の manager を viewer にはできない）
  app.patch<{ Params: { event_id: string; user_id: string } }>(
    '/organizer/events/:event_id/staff/:user_id',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = patchStaffBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const toRole = parsed.data.role
      const { event_id, user_id } = req.params
      const organizerId = req.organizerUser!.sub

      if (!(await assertEventOwnedByOrganizer(app.db, event_id, organizerId))) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このイベントへのアクセス権限がありません')
      }

      const [rows] = await app.db.query(
        `SELECT id, email, display_name, role, created_at
         FROM users WHERE id = ? AND event_id = ? AND role != 'participant' LIMIT 1`,
        [user_id, event_id],
      )
      const target = (rows as StaffRow[])[0]
      if (!target) {
        return sendFail(reply, 404, 'NOT_FOUND', 'スタッフが見つかりません')
      }

      if (toRole === 'viewer' && (await isLastManager(app, event_id, user_id))) {
        return sendFail(reply, 409, 'CONFLICT', '最後の管理者は閲覧者に変更できません')
      }

      const fromRole = target.role === 'admin' ? 'manager' : target.role
      await app.db.execute(
        'UPDATE users SET role = ? WHERE id = ? AND event_id = ?',
        [toRole, user_id, event_id],
      )

      await insertAuditLog(app.db, {
        eventId: event_id,
        actorId: organizerId,
        actorRole: 'organizer',
        action: 'staff.role_change',
        targetType: 'user',
        targetId: user_id,
        detail: { email: target.email, from_role: fromRole, to_role: toRole },
      })

      return sendOk(reply, {
        staff: toStaffPayload({ ...target, role: toRole }),
      })
    },
  )

  // スタッフ削除（最後の manager は削除できない）
  app.delete<{ Params: { event_id: string; user_id: string } }>(
    '/organizer/events/:event_id/staff/:user_id',
    { preHandler: pre },
    async (req, reply) => {
      const { event_id, user_id } = req.params
      const organizerId = req.organizerUser!.sub

      if (!(await assertEventOwnedByOrganizer(app.db, event_id, organizerId))) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このイベントへのアクセス権限がありません')
      }

      const [rows] = await app.db.query(
        `SELECT id, email, display_name, role, created_at
         FROM users WHERE id = ? AND event_id = ? AND role != 'participant' LIMIT 1`,
        [user_id, event_id],
      )
      const target = (rows as StaffRow[])[0]
      if (!target) {
        return sendFail(reply, 404, 'NOT_FOUND', 'スタッフが見つかりません')
      }

      const targetIsManager = target.role === 'manager' || target.role === 'admin'
      if (targetIsManager && (await isLastManager(app, event_id, user_id))) {
        return sendFail(reply, 409, 'CONFLICT', '最後の管理者は削除できません')
      }

      await app.db.execute(
        "DELETE FROM users WHERE id = ? AND event_id = ? AND role != 'participant'",
        [user_id, event_id],
      )

      await insertAuditLog(app.db, {
        eventId: event_id,
        actorId: organizerId,
        actorRole: 'organizer',
        action: 'staff.remove',
        targetType: 'user',
        targetId: user_id,
        detail: { email: target.email, role: target.role === 'admin' ? 'manager' : target.role },
      })

      return sendOk(reply, { deleted: true })
    },
  )
}
