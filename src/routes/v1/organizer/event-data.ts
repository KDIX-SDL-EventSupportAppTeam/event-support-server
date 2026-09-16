import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { clearAllEventData } from '../../../lib/event-data/clear-all.js'
import { insertAuditLog } from '../../../lib/audit.js'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireOrganizer } from '../../../plugins/auth.js'
import { assertEventOwnedByOrganizer } from '../../../lib/organizer.js'

const clearBody = z.object({
  confirm: z.literal('DELETE_ALL_EVENT_DATA'),
})

/**
 * イベントデータ全削除（主催者専用）。
 * 旧 /admin/events/:event_id/event-data の後継。所有イベントに対してのみ実行できる。
 * events 行・manager/viewer・organizer・audit_logs は残る（lib/event-data/clear-all.ts）。
 */
export async function organizerEventDataRoutes(app: FastifyInstance) {
  app.delete<{ Params: { event_id: string } }>(
    '/organizer/events/:event_id/event-data',
    { preHandler: [requireOrganizer] },
    async (req, reply) => {
      const organizerId = req.organizerUser!.sub
      const { event_id } = req.params

      // 1) 所有者確認（非所有・不存在・organizer_id NULL は同じ 403 に潰す）
      const owned = await assertEventOwnedByOrganizer(app.db, event_id, organizerId)
      if (!owned) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このイベントへのアクセス権限がありません')
      }

      // 2) 誤操作防止の確認トークン
      const parsed = clearBody.safeParse(req.body ?? {})
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '確認文字列が不正です')
      }

      // 3) 実削除（FK 依存順。lib は無変更で流用）
      let result
      try {
        result = await clearAllEventData(app.db, event_id)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'イベントデータの削除に失敗しました'
        return sendFail(reply, 500, 'INTERNAL_ERROR', msg)
      }

      // 4) 監査ログ（失敗しても本体の成功を巻き込まない: 改修プラン#10 の趣旨）
      try {
        await insertAuditLog(app.db, {
          eventId: event_id,
          actorId: organizerId,
          actorRole: 'organizer',
          action: 'event_data.clear',
          targetType: 'event',
          targetId: event_id,
          detail: result.deleted,
        })
      } catch (e) {
        req.log.warn({ err: e, event_id }, 'audit log write failed (event_data.clear)')
      }

      return sendOk(reply, { cleared: result.deleted })
    },
  )
}
