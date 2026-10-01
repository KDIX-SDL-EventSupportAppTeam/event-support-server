import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isoToMysqlUtc } from '../../../lib/datetime.js'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireStaff, requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'

const patchEventBody = z.object({
  name: z.string().min(1).max(500).optional(),
  date_start: z.string().optional(),
  date_end: z.string().optional(),
  venue: z.string().max(500).nullable().optional(),
  survey_url: z.string().url().max(2048).regex(/^https?:\/\//).nullable().optional(),
})

export async function adminEventRoutes(app: FastifyInstance) {
  const readPre = [requireStaff, requireEventMatchesJwt]
  const writePre = [requireManager, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id',
    { preHandler: readPre },
    async (req, reply) => {
      const [rows] = await app.db.query(
        `SELECT id, name, date_start, date_end, venue, survey_url, created_at
         FROM events WHERE id = ? LIMIT 1`,
        [req.params.event_id],
      )
      const e = (rows as {
        id: string
        name: string
        date_start: string
        date_end: string
        venue: string | null
        survey_url: string | null
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
          survey_url: e.survey_url,
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
      if (body.survey_url !== undefined) {
        fields.push('survey_url = ?')
        params.push(body.survey_url)   // null ならそのまま NULL で保存（未設定に戻す）
      }
      if (!fields.length) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '更新項目がありません')
      }

      const [existingRows] = await app.db.query(
        'SELECT id, name, date_start, date_end, venue, survey_url FROM events WHERE id = ? LIMIT 1',
        [req.params.event_id],
      )
      const before = (existingRows as {
        id: string
        name: string
        date_start: string
        date_end: string
        venue: string | null
        survey_url: string | null
      }[])[0]
      if (!before) {
        return sendFail(reply, 404, 'NOT_FOUND', 'イベントが見つかりません')
      }

      params.push(req.params.event_id)
      await app.db.execute(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`, params)

      const [rows] = await app.db.query(
        `SELECT id, name, date_start, date_end, venue, survey_url, created_at
         FROM events WHERE id = ? LIMIT 1`,
        [req.params.event_id],
      )
      const e = (rows as {
        id: string
        name: string
        date_start: string
        date_end: string
        venue: string | null
        survey_url: string | null
        created_at: string
      }[])[0]
      // 誰がいつ何に書き換えたかを残す（issue #156）。アンケート URL の「別の URL に飛んだ」を追跡できるようにする
      const snapshot = (r: {
        name: string
        date_start: string
        date_end: string
        venue: string | null
        survey_url: string | null
      }) => ({
        name: r.name,
        date_start: `${String(r.date_start).replace(' ', 'T')}Z`,
        date_end: `${String(r.date_end).replace(' ', 'T')}Z`,
        venue: r.venue,
        survey_url: r.survey_url,
      })
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'update',
        targetType: 'event',
        targetId: req.params.event_id,
        detail: { before: snapshot(before), after: snapshot(e) },
      })

      return sendOk(reply, {
        event: {
          id: e.id,
          name: e.name,
          date_start: `${String(e.date_start).replace(' ', 'T')}Z`,
          date_end: `${String(e.date_end).replace(' ', 'T')}Z`,
          venue: e.venue,
          survey_url: e.survey_url,
          created_at: `${String(e.created_at).replace(' ', 'T')}Z`,
        },
      })
    },
  )
}
