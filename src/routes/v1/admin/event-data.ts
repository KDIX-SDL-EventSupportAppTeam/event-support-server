import type { FastifyInstance } from 'fastify'
import { sendFail } from '../../../lib/response.js'
import { requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'

/**
 * イベントデータ全削除（チェックイン・回答・ブース等の一括消去）。
 *
 * 破壊的操作のため現在は**封印（無効化）**している。manager を含め、
 * この API からの実行はできず 403 を返す。
 * 方針: 将来は主催者(organizer)専用機能として再設計する
 *   （組織側の認証・イベント所有者確認を伴う別エンドポイントに移す）。
 * 実削除ロジックは `lib/event-data/clear-all.ts` に温存してある。
 */
export async function adminEventDataRoutes(app: FastifyInstance) {
  const pre = [requireManager, requireEventMatchesJwt]

  app.delete<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/event-data',
    { preHandler: pre },
    async (_req, reply) => {
      return sendFail(
        reply,
        403,
        'FORBIDDEN',
        'イベントデータの全削除は現在無効化されています（主催者専用機能として再設計予定）',
      )
    },
  )
}
