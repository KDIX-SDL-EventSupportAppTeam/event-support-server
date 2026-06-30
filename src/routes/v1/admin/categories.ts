import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireStaff, requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'

const categoryBody = z.object({
  name: z.string().min(1).max(200),
})

export async function adminCategoryRoutes(app: FastifyInstance) {
  const readPre = [requireStaff, requireEventMatchesJwt]
  const writePre = [requireManager, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/categories',
    { preHandler: readPre },
    async (req, reply) => {
      const [rows] = await app.db.query(
        'SELECT id, name FROM categories WHERE event_id = ? ORDER BY name ASC',
        [req.params.event_id],
      )
      return sendOk(reply, {
        categories: (rows as { id: string; name: string }[]).map((c) => ({
          id: c.id,
          name: c.name,
        })),
      })
    },
  )

  app.post<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/categories',
    { preHandler: writePre },
    async (req, reply) => {
      const parsed = categoryBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const id = randomUUID()
      await app.db.execute(
        'INSERT INTO categories (id, event_id, name) VALUES (?,?,?)',
        [id, req.params.event_id, parsed.data.name],
      )
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'category.create',
        targetType: 'category',
        targetId: id,
        detail: { name: parsed.data.name },
      })
      return sendOk(reply, { category: { id, name: parsed.data.name } }, 201)
    },
  )

  app.patch<{ Params: { event_id: string; category_id: string } }>(
    '/admin/events/:event_id/categories/:category_id',
    { preHandler: writePre },
    async (req, reply) => {
      const parsed = categoryBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const [result] = await app.db.execute(
        'UPDATE categories SET name = ? WHERE id = ? AND event_id = ?',
        [parsed.data.name, req.params.category_id, req.params.event_id],
      )
      const affected = (result as { affectedRows?: number }).affectedRows ?? 0
      if (!affected) {
        return sendFail(reply, 404, 'NOT_FOUND', 'カテゴリが見つかりません')
      }
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'category.update',
        targetType: 'category',
        targetId: req.params.category_id,
        detail: { name: parsed.data.name },
      })
      return sendOk(reply, { category: { id: req.params.category_id, name: parsed.data.name } })
    },
  )

  app.delete<{ Params: { event_id: string; category_id: string } }>(
    '/admin/events/:event_id/categories/:category_id',
    { preHandler: writePre },
    async (req, reply) => {
      const [result] = await app.db.execute(
        'DELETE FROM categories WHERE id = ? AND event_id = ?',
        [req.params.category_id, req.params.event_id],
      )
      const affected = (result as { affectedRows?: number }).affectedRows ?? 0
      if (!affected) {
        return sendFail(reply, 404, 'NOT_FOUND', 'カテゴリが見つかりません')
      }
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'category.delete',
        targetType: 'category',
        targetId: req.params.category_id,
      })
      return sendOk(reply, { deleted: true })
    },
  )
}
