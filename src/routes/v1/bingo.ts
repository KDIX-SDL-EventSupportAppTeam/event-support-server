import type { FastifyInstance } from 'fastify'
import { sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'
import { ensureCard } from '../../lib/bingo/ensureCard.js'
import { healUnlockedCardIfNeeded } from '../../lib/bingo/unlock.js'
import { calcCoinsEarned } from '../../lib/bingo/lines.js'

type CellRow = {
  position: number
  zone: 'CENTER' | 'OUTER'
  state: 'LOCKED' | 'EMPTY' | 'ACHIEVED'
  source: 'SIGNUP_BONUS' | 'FREE_VISIT' | 'RECOMMEND' | null
  booth_id: string | null
  booth_name: string | null
  manual_code: string | null
  reason_payload: string | null
}

/**
 * 参加者向けビンゴカード API。docs/.sdd/06-api/participant-api.md
 */
export async function bingoRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/bingo/card',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub

      const card = await ensureCard(app.db, eventId, uid)

      // self-healing（05-recommender/fallback.md, E14）: UNLOCKED なのに LOCKED マスが
      // 残っている（解放処理の途中失敗）ケースをこの GET で検知して修復する
      if (card.status === 'UNLOCKED') {
        await healUnlockedCardIfNeeded(app.db, app.config, eventId, uid, card.id)
      }

      const [rows] = await app.db.query(
        `SELECT c.position, c.zone, c.state, c.source, c.booth_id,
                b.name AS booth_name, b.manual_code,
                (SELECT l.reason_payload FROM cell_assignment_logs l
                 WHERE l.cell_id = c.id ORDER BY l.created_at DESC LIMIT 1) AS reason_payload
           FROM bingo_cells c
           LEFT JOIN booths b ON b.id = c.booth_id
          WHERE c.card_id = ?
          ORDER BY c.position ASC`,
        [card.id],
      )
      const cellRows = rows as CellRow[]

      const achieved = new Set(cellRows.filter((c) => c.state === 'ACHIEVED').map((c) => c.position))
      const centerFilled = cellRows.filter((c) => c.zone === 'CENTER' && c.state === 'ACHIEVED').length
      const freeVisitAchieved = cellRows.filter(
        (c) => c.zone === 'CENTER' && c.state === 'ACHIEVED' && c.source === 'FREE_VISIT',
      ).length
      const visitsToUnlock = card.status === 'UNLOCKED' ? 0 : Math.max(0, 3 - freeVisitAchieved)

      const cells = cellRows.map((c) => {
        // state='LOCKED' のマスでは booth・reason を必ず null にする（解放前に中身を漏らさない。README 絶対制約5）
        if (c.state === 'LOCKED') {
          return { position: c.position, zone: c.zone, state: c.state, source: c.source, booth: null, reason: null }
        }
        let reason: unknown = null
        if (c.reason_payload) {
          try {
            reason = JSON.parse(c.reason_payload)
          } catch {
            reason = null
          }
        }
        return {
          position: c.position,
          zone: c.zone,
          state: c.state,
          source: c.source,
          booth: c.booth_id ? { id: c.booth_id, name: c.booth_name, manual_code: c.manual_code } : null,
          // reason の生成ロジックは未決定（Q-3）。cell_assignment_logs.reason_payload の通し口のみ。
          reason,
        }
      })

      return sendOk(reply, {
        card_id: card.id,
        status: card.status,
        unlocked_at: card.unlockedAt ? `${card.unlockedAt.replace(' ', 'T')}Z` : null,
        rating_scale: app.config.ratingScale,
        progress: { center_filled: centerFilled, center_total: 4, visits_to_unlock: visitsToUnlock },
        coins: { earned: calcCoinsEarned(achieved), max: 4 },
        cells,
      })
    },
  )
}
