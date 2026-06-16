import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireAdmin, requireEventMatchesJwt } from '../../../plugins/auth.js'

const categoryBody = z.object({
  name: z.string().min(1).max(200),
})

export async function adminCategoryRoutes(app: FastifyInstance) {
  const pre = [requireAdmin, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/categories',
    { preHandler: pre },
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
    { preHandler: pre },
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
      return sendOk(reply, { category: { id, name: parsed.data.name } }, 201)
    },
  )

  app.patch<{ Params: { event_id: string; category_id: string } }>(
    '/admin/events/:event_id/categories/:category_id',
    { preHandler: pre },
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
      return sendOk(reply, { category: { id: req.params.category_id, name: parsed.data.name } })
    },
  )

  app.delete<{ Params: { event_id: string; category_id: string } }>(
    '/admin/events/:event_id/categories/:category_id',
    { preHandler: pre },
    async (req, reply) => {
      const [result] = await app.db.execute(
        'DELETE FROM categories WHERE id = ? AND event_id = ?',
        [req.params.category_id, req.params.event_id],
      )
      const affected = (result as { affectedRows?: number }).affectedRows ?? 0
      if (!affected) {
        return sendFail(reply, 404, 'NOT_FOUND', 'カテゴリが見つかりません')
      }
      return sendOk(reply, { deleted: true })
    },
  )
}
