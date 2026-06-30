import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { clearAllEventData } from '../../../lib/event-data/clear-all.js'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'

const clearBody = z.object({
  confirm: z.literal('DELETE_ALL_EVENT_DATA'),
})

export async function adminEventDataRoutes(app: FastifyInstance) {
  const pre = [requireManager, requireEventMatchesJwt]

  app.delete<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/event-data',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = clearBody.safeParse(req.body ?? {})
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '確認文字列が不正です')
      }
      try {
        const result = await clearAllEventData(app.db, req.params.event_id)
        return sendOk(reply, { cleared: result.deleted })
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'イベントデータの削除に失敗しました'
        return sendFail(reply, 500, 'INTERNAL_ERROR', msg)
      }
    },
  )
}
