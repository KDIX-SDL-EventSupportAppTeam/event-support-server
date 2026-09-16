import type { FastifyInstance } from 'fastify'
import { sendOk } from '../../../lib/response.js'
import { requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { getRecommenderOpsState } from '../../../lib/recommender/opsState.js'

/**
 * 推薦エンジンの `/ops/state` を中継する。
 * docs/specs/recommender-phase-linkage/01-ops-state-relay.md
 *
 * - 認可は既存の `/admin/*` と同じ（運営のみ）。監査ログは不要（読み取りのみ）
 * - 中継が失敗しても 500 を返さない。200 で `available: false` と `reason` を返す
 */
export async function adminRecommenderStateRoutes(app: FastifyInstance) {
  const pre = [requireStaff, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/recommender/state',
    { preHandler: pre },
    async (_req, reply) => {
      const result = await getRecommenderOpsState(app.config)
      return sendOk(reply, result)
    },
  )
}
