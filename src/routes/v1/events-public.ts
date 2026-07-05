import type { FastifyInstance } from 'fastify'
import { sendFail, sendOk } from '../../lib/response.js'

/**
 * 公開イベント情報（認証なし）。
 *
 * JoinPage / AdminLoginPage で UUID の生表示を解消するための最小限の情報だけを返す。
 * 認証付きの `/events/*`（booths 等）とは preHandler 構成が異なるため、
 * 誤って認証を外さないようファイルを分離している（.sdd 01-api.md 5 参照）。
 *
 * 返してよいのは id / name / date_start / date_end / venue の 5 フィールドのみ。
 * UUID が推測不能であることを認可の代わりとする（URL を知る人 = 招待された人）。
 */
export async function eventsPublicRoutes(app: FastifyInstance) {
  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/public',
    async (req, reply) => {
      const [rows] = await app.db.query(
        'SELECT id, name, date_start, date_end, venue FROM events WHERE id = ? LIMIT 1',
        [req.params.event_id],
      )
      const e = (rows as {
        id: string
        name: string
        date_start: string
        date_end: string
        venue: string | null
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
        },
      })
    },
  )
}
