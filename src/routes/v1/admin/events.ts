import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isoToMysqlUtc } from '../../../lib/datetime.js'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireStaff, requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'

const patchEventBody = z.object({
  name: z.string().min(1).max(500).optional(),
  date_start: z.string().optional(),
  date_end: z.string().optional(),
  venue: z.string().max(500).nullable().optional(),
})

export async function adminEventRoutes(app: FastifyInstance) {
  const readPre = [requireStaff, requireEventMatchesJwt]
  const writePre = [requireManager, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id',
    { preHandler: readPre },
    async (req, reply) => {
      const [rows] = await app.db.query(
        `SELECT id, name, date_start, date_end, venue, created_at
         FROM events WHERE id = ? LIMIT 1`,
        [req.params.event_id],
      )
      const e = (rows as {
        id: string
        name: string
        date_start: string
        date_end: string
        venue: string | null
        created_at: string
      }[])[0]
      if (!e) {
        return sendFail(reply, 404, 'NOT_FOUND', 'イベントが見つかりません')
      }
      return sendOk(reply, {
        event: {
          id: e.id,
          name: e.name,
          date_start: `${String(e.date_start).replace(' ', 'T')}Z`,
          date_end: `${String(e.date_end).replace(' ', 'T')}Z`,
          venue: e.venue,
          created_at: `${String(e.created_at).replace(' ', 'T')}Z`,
        },
      })
    },
  )

  app.patch<{ Params: { event_id: string } }>(
    '/admin/events/:event_id',
    { preHandler: writePre },
    async (req, reply) => {
      const parsed = patchEventBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data
      const fields: string[] = []
      const params: unknown[] = []

      if (body.name !== undefined) {
        fields.push('name = ?')
        params.push(body.name)
      }
      if (body.date_start !== undefined) {
        try {
          fields.push('date_start = ?')
          params.push(isoToMysqlUtc(body.date_start))
        } catch {
          return sendFail(reply, 422, 'VALIDATION_ERROR', 'date_start が不正です')
        }
      }
      if (body.date_end !== undefined) {
        try {
          fields.push('date_end = ?')
          params.push(isoToMysqlUtc(body.date_end))
        } catch {
          return sendFail(reply, 422, 'VALIDATION_ERROR', 'date_end が不正です')
        }
      }
      if (body.venue !== undefined) {
        fields.push('venue = ?')
        params.push(body.venue)
      }
      if (!fields.length) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '更新項目がありません')
      }

      const [existingRows] = await app.db.query(
        'SELECT id FROM events WHERE id = ? LIMIT 1',
        [req.params.event_id],
      )
      if (!(existingRows as { id: string }[])[0]) {
        return sendFail(reply, 404, 'NOT_FOUND', 'イベントが見つかりません')
      }

      params.push(req.params.event_id)
      await app.db.execute(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`, params)

      const [rows] = await app.db.query(
        `SELECT id, name, date_start, date_end, venue, created_at
         FROM events WHERE id = ? LIMIT 1`,
        [req.params.event_id],
      )
      const e = (rows as {
        id: string
        name: string
        date_start: string
        date_end: string
        venue: string | null
        created_at: string
      }[])[0]
      return sendOk(reply, {
        event: {
          id: e.id,
          name: e.name,
          date_start: `${String(e.date_start).replace(' ', 'T')}Z`,
          date_end: `${String(e.date_end).replace(' ', 'T')}Z`,
          venue: e.venue,
          created_at: `${String(e.created_at).replace(' ', 'T')}Z`,
        },
      })
    },
  )
}
