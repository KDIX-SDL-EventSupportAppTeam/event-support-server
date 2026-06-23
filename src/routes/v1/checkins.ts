import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isoToMysqlUtc, utcMysqlNow } from '../../lib/datetime.js'
import { sendFail, sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'

const checkinBody = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('qr'),
    booth_id: z.string().uuid(),
    checked_in_at: z.string(),
  }),
  z.object({
    method: z.literal('manual'),
    manual_code: z.string().min(1).max(6),
    checked_in_at: z.string(),
  }),
])

const ratingBody = z.object({ rating: z.number().int().min(1).max(5) })

export async function checkinRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

  app.post<{ Params: { event_id: string } }>(
    '/events/:event_id/checkins',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = checkinBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub
      const body = parsed.data
      let boothId: string
      let boothName: string
      let method: 'qr' | 'manual'
      let checkedMysql: string
      try {
        checkedMysql = isoToMysqlUtc(body.checked_in_at)
      } catch {
        return sendFail(reply, 422, 'VALIDATION_ERROR', 'checked_in_at が不正です')
      }

      if (body.method === 'qr') {
        method = 'qr'
        boothId = body.booth_id
        const [b] = await app.db.query(
          'SELECT id, name FROM booths WHERE id = ? AND event_id = ? LIMIT 1',
          [boothId, eventId],
        )
        const row = (b as { id: string; name: string }[])[0]
        if (!row) {
          return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
        }
        boothName = row.name
      } else {
        method = 'manual'
        const code = body.manual_code.trim().toUpperCase()
        const [b] = await app.db.query(
          'SELECT id, name FROM booths WHERE event_id = ? AND UPPER(manual_code) = ? LIMIT 1',
          [eventId, code],
        )
        const row = (b as { id: string; name: string }[])[0]
        if (!row) {
          return sendFail(reply, 404, 'NOT_FOUND', '手動コードに一致するブースがありません')
        }
        boothId = row.id
        boothName = row.name
      }

      const id = randomUUID()
      const synced = utcMysqlNow()
      try {
        await app.db.execute(
          `INSERT INTO check_ins (id, user_id, booth_id, event_id, checkin_method, checked_in_at, synced_at)
           VALUES (?,?,?,?,?,?,?)`,
          [id, uid, boothId, eventId, method, checkedMysql, synced],
        )
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === 'ER_DUP_ENTRY') {
          return sendFail(reply, 409, 'CONFLICT', 'このブースには既にチェックイン済みです')
        }
        throw e
      }

      app.io.to(`event:${eventId}:admin`).emit('checkin:new', {
        booth_id: boothId,
        booth_name: boothName,
        user_display_name: req.jwtUser!.display_name,
        checked_in_at: body.checked_in_at,
      })

      return sendOk(reply, {
        checkin_id: id,
        booth: { id: boothId, name: boothName },
        synced_at: `${synced.replace(' ', 'T')}Z`,
      })
    },
  )

  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/checkins',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub
      const [rows] = await app.db.query(
        `SELECT ci.id, ci.booth_id, b.name AS booth_name, ci.checkin_method, ci.checked_in_at, ci.synced_at
         FROM check_ins ci
         JOIN booths b ON b.id = ci.booth_id
         WHERE ci.user_id = ? AND ci.event_id = ?
         ORDER BY ci.checked_in_at DESC`,
        [uid, eventId],
      )
      const list = (rows as {
        id: string
        booth_id: string
        booth_name: string
        checkin_method: string
        checked_in_at: string
        synced_at: string | null
      }[]).map((r) => ({
        id: r.id,
        booth_id: r.booth_id,
        booth_name: r.booth_name,
        method: r.checkin_method,
        checked_in_at: `${String(r.checked_in_at).replace(' ', 'T')}Z`,
        synced_at: r.synced_at ? `${String(r.synced_at).replace(' ', 'T')}Z` : null,
      }))
      return sendOk(reply, { checkins: list })
    },
  )

  app.post<{ Params: { event_id: string; checkin_id: string } }>(
    '/events/:event_id/checkins/:checkin_id/rating',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = ratingBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const { event_id, checkin_id } = req.params
      const uid = req.jwtUser!.sub
      const [rows] = await app.db.query(
        `SELECT ci.booth_id, b.name AS booth_name
         FROM check_ins ci
         JOIN booths b ON b.id = ci.booth_id
         WHERE ci.id = ? AND ci.user_id = ? AND ci.event_id = ? LIMIT 1`,
        [checkin_id, uid, event_id],
      )
      const ci = (rows as { booth_id: string; booth_name: string }[])[0]
      if (!ci) {
        return sendFail(reply, 404, 'NOT_FOUND', 'チェックインが見つかりません')
      }
      const rid = randomUUID()
      try {
        await app.db.execute(
          `INSERT INTO booth_ratings (id, user_id, booth_id, event_id, checkin_id, rating)
           VALUES (?,?,?,?,?,?)`,
          [rid, uid, ci.booth_id, event_id, checkin_id, parsed.data.rating],
        )
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === 'ER_DUP_ENTRY') {
          return sendFail(reply, 409, 'CONFLICT', 'このチェックインには既に評価があります')
        }
        throw e
      }

      app.io.to(`event:${event_id}:admin`).emit('rating:new', {
        booth_id: ci.booth_id,
        booth_name: ci.booth_name,
        rating: parsed.data.rating,
        user_display_name: req.jwtUser!.display_name,
      })

      return sendOk(reply, { rating_id: rid })
    },
  )
}
