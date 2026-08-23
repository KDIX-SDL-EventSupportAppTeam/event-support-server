import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { utcMysqlNow } from '../../../lib/datetime.js'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'

const activeBody = z.object({ is_active: z.boolean() })
const reassignBody = z.object({
  from_booth_id: z.string().uuid(),
  to_booth_id: z.string().uuid(),
})

/**
 * 運営向けビンゴ関連エンドポイント（docs/.sdd/06-api/admin-api.md）。
 * ブース有効・無効切り替えと、当日中止ブースの割当済みマス差し替え救済。
 */
export async function adminBingoRoutes(app: FastifyInstance) {
  const pre = [requireManager, requireEventMatchesJwt]

  // 1. ブースの有効・無効切り替え（E5）
  app.patch<{ Params: { event_id: string; booth_id: string } }>(
    '/events/:event_id/admin/booths/:booth_id/active',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = activeBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const { event_id, booth_id } = req.params
      const [result] = await app.db.execute(
        'UPDATE booths SET is_active = ? WHERE id = ? AND event_id = ?',
        [parsed.data.is_active ? 1 : 0, booth_id, event_id],
      )
      const affected = (result as { affectedRows: number }).affectedRows
      if (affected !== 1) {
        return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
      }
      await insertAuditLog(app.db, {
        eventId: event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'booth.active_toggle',
        targetType: 'booth',
        targetId: booth_id,
        detail: { is_active: parsed.data.is_active },
      })
      return sendOk(reply, { booth_id, is_active: parsed.data.is_active })
    },
  )

  // 2. 割当済みマスのブース差し替え（E5）
  app.post<{ Params: { event_id: string } }>(
    '/events/:event_id/admin/bingo/reassign',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = reassignBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const eventId = req.params.event_id
      const { from_booth_id, to_booth_id } = parsed.data

      // 対象: from_booth_id が入っている、まだ ACHIEVED でないマス（該当イベントのカードに限る）
      const [targetRows] = await app.db.query(
        `SELECT c.id, c.card_id FROM bingo_cells c
           JOIN bingo_cards k ON k.id = c.card_id
          WHERE k.event_id = ? AND c.booth_id = ? AND c.state <> 'ACHIEVED'`,
        [eventId, from_booth_id],
      )
      const targets = targetRows as { id: string; card_id: string }[]
      if (targets.length === 0) {
        return sendOk(reply, { reassigned_count: 0 })
      }

      // 差し替え先が既にそのカードに載っている場合はスキップ（UNIQUE (card_id, booth_id) 違反回避）
      const [conflictRows] = await app.db.query(
        `SELECT card_id FROM bingo_cells WHERE booth_id = ? AND card_id IN (${targets.map(() => '?').join(',')})`,
        [to_booth_id, ...targets.map((t) => t.card_id)],
      )
      const conflictCardIds = new Set((conflictRows as { card_id: string }[]).map((r) => r.card_id))
      const applicable = targets.filter((t) => !conflictCardIds.has(t.card_id))

      let reassignedCount = 0
      if (applicable.length > 0) {
        const now = utcMysqlNow()
        const ids = applicable.map((t) => t.id)
        const [result] = await app.db.execute(
          `UPDATE bingo_cells SET booth_id = ?, assigned_at = ?
             WHERE id IN (${ids.map(() => '?').join(',')}) AND state <> 'ACHIEVED'`,
          [to_booth_id, now, ...ids],
        )
        reassignedCount = (result as { affectedRows: number }).affectedRows

        // cell_assignment_logs へ記録（strategy='ADMIN_REASSIGN'）
        const [gcRows] = await app.db.query(
          `SELECT COUNT(*) AS c FROM check_ins ci JOIN users u ON u.id = ci.user_id
            WHERE ci.event_id = ? AND u.role = 'participant'`,
          [eventId],
        )
        const globalCheckinCount = Number((gcRows as { c: number }[])[0]?.c ?? 0)
        const placeholders = ids.map(() => '(?,?,?,?,?,?)').join(',')
        const values = ids.flatMap((cellId) => [
          randomUUID(),
          cellId,
          'ADMIN_REASSIGN',
          null,
          JSON.stringify({ kind: 'admin_reassign', from_booth_id, to_booth_id }),
          globalCheckinCount,
        ])
        await app.db.execute(
          `INSERT INTO cell_assignment_logs (id, cell_id, strategy, score, reason_payload, global_checkin_count)
           VALUES ${placeholders}`,
          values,
        )
      }

      await insertAuditLog(app.db, {
        eventId,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'bingo.reassign',
        targetType: 'booth',
        targetId: from_booth_id,
        detail: { from_booth_id, to_booth_id, reassigned_count: reassignedCount },
      })

      return sendOk(reply, { reassigned_count: reassignedCount })
    },
  )
}
