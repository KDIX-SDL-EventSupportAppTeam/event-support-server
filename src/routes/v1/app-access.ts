import type { FastifyInstance } from 'fastify'
import { sendFail, sendOk } from '../../lib/response.js'
import { fetchAppAccessRow, resolveEffectiveAccess } from '../../lib/app-access.js'

/**
 * 公開エンドポイント（認証なし）。実効開放状態の取得。完了画面が参照する（06-api.md）。
 * イベント名等の内部情報は返さない。存在しない event_id は 404。
 * app_closes_at / updated_by は返さない。
 */
export async function appAccessRoutes(app: FastifyInstance) {
  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/app-access',
    async (req, reply) => {
      const eventId = req.params.event_id
      const [eventRows] = await app.db.query('SELECT id FROM events WHERE id = ? LIMIT 1', [eventId])
      if (!(eventRows as { id: string }[])[0]) {
        return sendFail(reply, 404, 'NOT_FOUND', 'イベントが見つかりません')
      }

      const row = await fetchAppAccessRow(app.db, eventId)
      const effective = resolveEffectiveAccess(row)

      return sendOk(reply, {
        event_id: eventId,
        is_open: effective.is_open,
        mode: effective.mode,
        app_opens_at: effective.app_opens_at,
        pre_survey_closes_at: effective.pre_survey_closes_at,
        is_pre_survey_open: effective.is_pre_survey_open,
        server_time: effective.server_time,
      })
    },
  )
}
