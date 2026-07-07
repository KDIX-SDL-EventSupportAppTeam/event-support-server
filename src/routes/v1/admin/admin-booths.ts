import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'

const boothBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category_id: z.string().uuid().nullable().optional(),
  manual_code: z.string().min(1).max(6),
  tags: z.array(z.string().min(1).max(255)).optional(),
})

async function replaceBoothTags(
  app: FastifyInstance,
  boothId: string,
  tags: string[] | undefined,
) {
  if (tags === undefined) return
  await app.db.execute('DELETE FROM booth_tags WHERE booth_id = ?', [boothId])
  for (const tag of tags) {
    await app.db.execute(
      'INSERT INTO booth_tags (id, booth_id, tag) VALUES (?,?,?)',
      [randomUUID(), boothId, tag],
    )
  }
}

export async function adminBoothRoutes(app: FastifyInstance) {
  const pre = [requireManager, requireEventMatchesJwt]

  app.post<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/booths',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = boothBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data
      const id = randomUUID()
      try {
        await app.db.execute(
          `INSERT INTO booths (id, event_id, name, description, category_id, manual_code)
           VALUES (?,?,?,?,?,?)`,
          [
            id,
            req.params.event_id,
            body.name,
            body.description ?? null,
            body.category_id ?? null,
            body.manual_code.trim().toUpperCase(),
          ],
        )
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === 'ER_DUP_ENTRY') {
          return sendFail(reply, 409, 'CONFLICT', 'manual_code が既に使われています')
        }
        throw e
      }
      await replaceBoothTags(app, id, body.tags)
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'booth.create',
        targetType: 'booth',
        targetId: id,
        detail: { name: body.name, manual_code: body.manual_code.trim().toUpperCase() },
      })
      return sendOk(
        reply,
        {
          booth: {
            id,
            name: body.name,
            description: body.description ?? '',
            category_id: body.category_id ?? null,
            manual_code: body.manual_code.trim().toUpperCase(),
            tags: body.tags ?? [],
          },
        },
        201,
      )
    },
  )

  app.patch<{ Params: { event_id: string; booth_id: string } }>(
    '/admin/events/:event_id/booths/:booth_id',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = boothBody.partial().safeParse(req.body)
      if (!parsed.success || !Object.keys(parsed.data).length) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data
      const fields: string[] = []
      const params: unknown[] = []

      if (body.name !== undefined) {
        fields.push('name = ?')
        params.push(body.name)
      }
      if (body.description !== undefined) {
        fields.push('description = ?')
        params.push(body.description)
      }
      if (body.category_id !== undefined) {
        fields.push('category_id = ?')
        params.push(body.category_id)
      }
      if (body.manual_code !== undefined) {
        fields.push('manual_code = ?')
        params.push(body.manual_code.trim().toUpperCase())
      }

      const [existingRows] = await app.db.query(
        'SELECT id FROM booths WHERE id = ? AND event_id = ? LIMIT 1',
        [req.params.booth_id, req.params.event_id],
      )
      if (!(existingRows as { id: string }[])[0]) {
        return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
      }

      if (fields.length) {
        params.push(req.params.booth_id, req.params.event_id)
        try {
          await app.db.execute(
            `UPDATE booths SET ${fields.join(', ')} WHERE id = ? AND event_id = ?`,
            params,
          )
        } catch (e: unknown) {
          const err = e as { code?: string }
          if (err.code === 'ER_DUP_ENTRY') {
            return sendFail(reply, 409, 'CONFLICT', 'manual_code が既に使われています')
          }
          throw e
        }
      }

      await replaceBoothTags(app, req.params.booth_id, body.tags)
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'booth.update',
        targetType: 'booth',
        targetId: req.params.booth_id,
        detail: body,
      })

      const [rows] = await app.db.query(
        `SELECT id, name, description, category_id, manual_code
         FROM booths WHERE id = ? AND event_id = ? LIMIT 1`,
        [req.params.booth_id, req.params.event_id],
      )
      const b = (rows as {
        id: string
        name: string
        description: string | null
        category_id: string | null
        manual_code: string
      }[])[0]
      const [tags] = await app.db.query(
        'SELECT tag FROM booth_tags WHERE booth_id = ? ORDER BY tag ASC',
        [req.params.booth_id],
      )
      return sendOk(reply, {
        booth: {
          id: b.id,
          name: b.name,
          description: b.description ?? '',
          category_id: b.category_id,
          manual_code: b.manual_code,
          tags: (tags as { tag: string }[]).map((t) => t.tag),
        },
      })
    },
  )

  app.delete<{ Params: { event_id: string; booth_id: string } }>(
    '/admin/events/:event_id/booths/:booth_id',
    { preHandler: pre },
    async (req, reply) => {
      const [result] = await app.db.execute(
        'DELETE FROM booths WHERE id = ? AND event_id = ?',
        [req.params.booth_id, req.params.event_id],
      )
      const affected = (result as { affectedRows?: number }).affectedRows ?? 0
      if (!affected) {
        return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
      }
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'booth.delete',
        targetType: 'booth',
        targetId: req.params.booth_id,
      })
      return sendOk(reply, { deleted: true })
    },
  )
}
