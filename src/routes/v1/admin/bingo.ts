import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { utcMysqlNow } from '../../../lib/datetime.js'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'
import { listFallbackCandidates, pickTopFallbackBoothIds } from '../../../lib/bingo/fallback.js'

const activeBody = z.object({ is_active: z.boolean() })
const reassignBody = z.object({ booth_id: z.string().uuid() })

/**
 * 運営向けビンゴ関連エンドポイント（docs/specs/bingo-dynamic-unlock/06-api/admin-api.md）。
 * ブース有効・無効切り替えと、当日中止ブースの割当済みマス差し替え救済。
 */
export async function adminBingoRoutes(app: FastifyInstance) {
  const pre = [requireManager, requireEventMatchesJwt]

  // 1. ブースの有効・無効切り替え
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

  // 2. 当日中止ブースが載っているマスの差し替え救済（docs/specs/.../06-api/admin-api.md）
  //    対象: is_revealed=1 AND is_achieved=0 AND booth_id=booth_id のマス（達成済みのマスは触らない）
  app.post<{ Params: { event_id: string } }>(
    '/events/:event_id/admin/bingo/reassign',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = reassignBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const eventId = req.params.event_id
      const { booth_id: fromBoothId } = parsed.data

      const [targetRows] = await app.db.query(
        `SELECT c.id, c.card_id FROM bingo_cells c
           JOIN bingo_cards k ON k.id = c.card_id
          WHERE k.event_id = ? AND c.booth_id = ? AND c.is_revealed = 1 AND c.is_achieved = 0`,
        [eventId, fromBoothId],
      )
      const targets = targetRows as { id: string; card_id: string }[]
      if (targets.length === 0) {
        return sendOk(reply, { affected_cards: 0, reassigned_cells: 0, cleared_cells: 0 })
      }

      const now = utcMysqlNow()
      const affectedCardIds = new Set<string>()
      let reassignedCells = 0
      let clearedCells = 0

      // カードごとに処理する（除外集合＝そのカードに既に載っているブース、がカード単位で異なるため）
      const targetsByCard = new Map<string, { id: string; card_id: string }[]>()
      for (const t of targets) {
        const list = targetsByCard.get(t.card_id) ?? []
        list.push(t)
        targetsByCard.set(t.card_id, list)
      }

      for (const [cardId, cells] of targetsByCard) {
        const [cardBoothRows] = await app.db.query(
          `SELECT booth_id FROM bingo_cells WHERE card_id = ? AND booth_id IS NOT NULL`,
          [cardId],
        )
        const excludeSet = new Set((cardBoothRows as { booth_id: string }[]).map((r) => r.booth_id))

        for (const cell of cells) {
          const fallbackCandidates = await listFallbackCandidates(app.db, eventId, [...excludeSet])
          const [replacementId] = pickTopFallbackBoothIds(fallbackCandidates, 1)
          const replacement = replacementId ?? null
          if (replacement) excludeSet.add(replacement)

          const [result] = await app.db.execute(
            `UPDATE bingo_cells SET booth_id = ?, assigned_at = ?
               WHERE id = ? AND is_revealed = 1 AND is_achieved = 0`,
            [replacement, now, cell.id],
          )
          const affected = (result as { affectedRows: number }).affectedRows
          if (affected !== 1) continue // 差し替え前に達成された等、競合でスキップ

          affectedCardIds.add(cardId)
          if (replacement) {
            reassignedCells += 1
          } else {
            clearedCells += 1
          }
        }
      }

      await insertAuditLog(app.db, {
        eventId,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'bingo.reassign',
        targetType: 'booth',
        targetId: fromBoothId,
        detail: {
          booth_id: fromBoothId,
          affected_cards: affectedCardIds.size,
          reassigned_cells: reassignedCells,
          cleared_cells: clearedCells,
        },
      })

      return sendOk(reply, {
        affected_cards: affectedCardIds.size,
        reassigned_cells: reassignedCells,
        cleared_cells: clearedCells,
      })
    },
  )
}
