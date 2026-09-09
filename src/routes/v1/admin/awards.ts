import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireManager, requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'
import { fetchAwardSettings } from '../../../lib/award/settings.js'

/**
 * 運営向けアワード API（issue #124）。
 *
 * - 閲覧（一覧・集計）は `viewer` 可
 * - 追加・編集・削除・開閉は `manager` 限定
 * - 集計は `users.role = 'participant'` のみ（スタッフ・出展者の試し投票は数えない）
 *
 * 仕様: docs/specs/gacha-and-award/06-api/award-api.md
 */

const createBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  color: z.string().min(1).max(32).optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
})

const patchBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  color: z.string().min(1).max(32).optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
})

const votingBody = z.object({ is_open: z.boolean() })

export async function adminAwardRoutes(app: FastifyInstance) {
  const staff = [requireStaff, requireEventMatchesJwt]
  const manager = [requireManager, requireEventMatchesJwt]

  // 賞の一覧（票数つき）。participant の票だけを数える。
  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/awards',
    { preHandler: staff },
    async (req, reply) => {
      const eventId = req.params.event_id
      const settings = await fetchAwardSettings(app.db, eventId)
      const [rows] = await app.db.query(
        `SELECT a.id, a.name, a.description, a.color, a.sort_order,
                (SELECT COUNT(*)
                   FROM award_votes v
                   JOIN users u ON u.id = v.user_id AND (u.role = 'participant' OR u.role IS NULL)
                  WHERE v.award_id = a.id) AS vote_count
           FROM awards a
          WHERE a.event_id = ?
          ORDER BY a.sort_order ASC, a.name ASC`,
        [eventId],
      )
      const awards = (rows as {
        id: string; name: string; description: string | null; color: string; sort_order: number; vote_count: number
      }[]).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description ?? '',
        color: a.color,
        sort_order: Number(a.sort_order) || 0,
        vote_count: Number(a.vote_count) || 0,
      }))
      return sendOk(reply, { voting_open: settings.isOpen, awards })
    },
  )

  // 賞の追加（manager）
  app.post<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/awards',
    { preHandler: manager },
    async (req, reply) => {
      const parsed = createBody.safeParse(req.body)
      if (!parsed.success) return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      const eventId = req.params.event_id
      const body = parsed.data
      const id = randomUUID()

      // uq_award_name_event の衝突を INSERT 前に確認する（さくらは重複キーを 500 に潰す）
      const [dup] = await app.db.query(
        'SELECT id FROM awards WHERE event_id = ? AND name = ? LIMIT 1',
        [eventId, body.name],
      )
      if ((dup as { id: string }[])[0]) {
        return sendFail(reply, 409, 'CONFLICT', '同じ名前の賞が既にあります')
      }

      await app.db.execute(
        `INSERT INTO awards (id, event_id, name, description, color, sort_order)
         VALUES (?,?,?,?,?,?)`,
        [id, eventId, body.name, body.description ?? null, body.color ?? 'pink', body.sort_order ?? 0],
      )
      await insertAuditLog(app.db, {
        eventId, actorId: req.jwtUser!.sub, actorRole: req.jwtUser!.role ?? 'manager',
        action: 'award.create', targetType: 'award', targetId: id, detail: { name: body.name },
      })
      return sendOk(reply, {
        award: {
          id, name: body.name, description: body.description ?? '',
          color: body.color ?? 'pink', sort_order: body.sort_order ?? 0, vote_count: 0,
        },
      }, 201)
    },
  )

  // 賞の編集（manager）
  app.patch<{ Params: { event_id: string; award_id: string } }>(
    '/admin/events/:event_id/awards/:award_id',
    { preHandler: manager },
    async (req, reply) => {
      const parsed = patchBody.safeParse(req.body)
      if (!parsed.success || !Object.keys(parsed.data).length) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const { event_id: eventId, award_id: awardId } = req.params
      const [exists] = await app.db.query(
        'SELECT id FROM awards WHERE id = ? AND event_id = ? LIMIT 1',
        [awardId, eventId],
      )
      if (!(exists as { id: string }[])[0]) return sendFail(reply, 404, 'NOT_FOUND', '賞が見つかりません')

      const body = parsed.data
      const fields: string[] = []
      const params: unknown[] = []
      if (body.name !== undefined) { fields.push('name = ?'); params.push(body.name) }
      if (body.description !== undefined) { fields.push('description = ?'); params.push(body.description) }
      if (body.color !== undefined) { fields.push('color = ?'); params.push(body.color) }
      if (body.sort_order !== undefined) { fields.push('sort_order = ?'); params.push(body.sort_order) }

      if (fields.length) {
        params.push(awardId, eventId)
        try {
          await app.db.execute(
            `UPDATE awards SET ${fields.join(', ')} WHERE id = ? AND event_id = ?`,
            params,
          )
        } catch (e: unknown) {
          if ((e as { code?: string }).code === 'ER_DUP_ENTRY') {
            return sendFail(reply, 409, 'CONFLICT', '同じ名前の賞が既にあります')
          }
          throw e
        }
      }
      await insertAuditLog(app.db, {
        eventId, actorId: req.jwtUser!.sub, actorRole: req.jwtUser!.role ?? 'manager',
        action: 'award.update', targetType: 'award', targetId: awardId, detail: body,
      })

      const [rows] = await app.db.query(
        'SELECT id, name, description, color, sort_order FROM awards WHERE id = ? LIMIT 1',
        [awardId],
      )
      const a = (rows as { id: string; name: string; description: string | null; color: string; sort_order: number }[])[0]
      return sendOk(reply, {
        award: { id: a.id, name: a.name, description: a.description ?? '', color: a.color, sort_order: Number(a.sort_order) || 0 },
      })
    },
  )

  // 賞の削除（manager）。award_votes は FK CASCADE で一緒に消える。
  app.delete<{ Params: { event_id: string; award_id: string } }>(
    '/admin/events/:event_id/awards/:award_id',
    { preHandler: manager },
    async (req, reply) => {
      const { event_id: eventId, award_id: awardId } = req.params
      const [voteCount] = await app.db.query(
        'SELECT COUNT(*) AS c FROM award_votes WHERE award_id = ?',
        [awardId],
      )
      const deletedVotes = Number((voteCount as { c: number }[])[0]?.c ?? 0)
      const [result] = await app.db.execute(
        'DELETE FROM awards WHERE id = ? AND event_id = ?',
        [awardId, eventId],
      )
      if (!((result as { affectedRows?: number }).affectedRows ?? 0)) {
        return sendFail(reply, 404, 'NOT_FOUND', '賞が見つかりません')
      }
      await insertAuditLog(app.db, {
        eventId, actorId: req.jwtUser!.sub, actorRole: req.jwtUser!.role ?? 'manager',
        action: 'award.delete', targetType: 'award', targetId: awardId, detail: { deleted_votes: deletedVotes },
      })
      return sendOk(reply, { deleted: true, deleted_votes: deletedVotes })
    },
  )

  // 投票の開閉（manager 限定）。監査ログに残す。
  app.patch<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/awards/voting',
    { preHandler: manager },
    async (req, reply) => {
      const eventId = req.params.event_id
      const parsed = votingBody.safeParse(req.body)
      if (!parsed.success) return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')

      const before = await fetchAwardSettings(app.db, eventId)
      await app.db.execute(
        `INSERT INTO award_settings (event_id, is_open) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE is_open = VALUES(is_open)`,
        [eventId, parsed.data.is_open ? 1 : 0],
      )
      const after = await fetchAwardSettings(app.db, eventId)
      await insertAuditLog(app.db, {
        eventId, actorId: req.jwtUser!.sub, actorRole: req.jwtUser!.role ?? 'manager',
        action: 'award.voting.update', targetType: 'award_settings', targetId: eventId,
        detail: { before: before.isOpen, after: after.isOpen },
      })
      return sendOk(reply, { is_open: after.isOpen })
    },
  )

  // ブース別の票数（降順）。同数の順位付けはしない。participant のみ。
  app.get<{ Params: { event_id: string; award_id: string } }>(
    '/admin/events/:event_id/awards/:award_id/tally',
    { preHandler: staff },
    async (req, reply) => {
      const { event_id: eventId, award_id: awardId } = req.params
      const [awardRows] = await app.db.query(
        'SELECT id, name FROM awards WHERE id = ? AND event_id = ? LIMIT 1',
        [awardId, eventId],
      )
      const award = (awardRows as { id: string; name: string }[])[0]
      if (!award) return sendFail(reply, 404, 'NOT_FOUND', '賞が見つかりません')

      const [rows] = await app.db.query(
        `SELECT v.booth_id AS booth_id, b.name AS booth_name, COUNT(*) AS votes
           FROM award_votes v
           JOIN users u  ON u.id = v.user_id AND (u.role = 'participant' OR u.role IS NULL)
           JOIN booths b ON b.id = v.booth_id
          WHERE v.award_id = ?
          GROUP BY v.booth_id, b.name
          ORDER BY votes DESC, b.name ASC`,
        [awardId],
      )
      const booths = (rows as { booth_id: string; booth_name: string; votes: number }[]).map((r) => ({
        booth_id: r.booth_id,
        booth_name: r.booth_name,
        votes: Number(r.votes) || 0,
      }))
      const totalVotes = booths.reduce((s, b) => s + b.votes, 0)
      return sendOk(reply, {
        award: { id: award.id, name: award.name },
        total_votes: totalVotes,
        booths,
      })
    },
  )
}
