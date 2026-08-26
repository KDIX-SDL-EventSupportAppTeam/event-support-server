import type { FastifyInstance } from 'fastify'
import { sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'
import { ensureCard, ALL_POSITIONS } from '../../lib/bingo/ensureCard.js'
import { healUnlockedCardIfNeeded } from '../../lib/bingo/unlock.js'
import { countCompletedLines } from '../../lib/bingo/lines.js'
import { CENTER_POSITIONS } from '../../lib/bingo/unlockPairs.js'

type CellRow = {
  position: number
  zone: 'CENTER' | 'OUTER'
  is_revealed: number
  is_achieved: number
  source: 'PRESURVEY' | 'FREE_VISIT' | 'RECOMMEND' | null
  booth_id: string | null
  booth_name: string | null
  manual_code: string | null
  booth_description: string | null
}

type UnlockEventRow = {
  pair_key: string
  released_positions: string
  created_at: string
}

/**
 * 参加者向けビンゴカード API。docs/specs/bingo-dynamic-unlock/06-api/participant-api.md
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

      // self-healing（05-recommender/fallback.md）: 解放イベントはあるのにマスが is_revealed=0 の
      // まま残っている（解放処理の途中失敗）ケースをこの GET で検知して修復する
      await healUnlockedCardIfNeeded(app.db, app.config, eventId, uid, card.id)

      const [rows] = await app.db.query(
        `SELECT c.position, c.zone, c.is_revealed, c.is_achieved, c.source, c.booth_id,
                b.name AS booth_name, b.manual_code, b.description AS booth_description
           FROM bingo_cells c
           LEFT JOIN booths b ON b.id = c.booth_id
          WHERE c.card_id = ?
          ORDER BY c.position ASC`,
        [card.id],
      )
      const cellRows = rows as CellRow[]

      const achieved = new Set(cellRows.filter((c) => c.is_achieved === 1).map((c) => c.position))
      const centerAchieved = cellRows.filter((c) => c.zone === 'CENTER' && c.is_achieved === 1).length
      const revealedCells = cellRows.filter((c) => c.is_revealed === 1).length
      const achievedCells = achieved.size

      const cells = ALL_POSITIONS.map((position) => {
        const c = cellRows.find((r) => r.position === position)
        if (!c) {
          // 通常はここに来ない（ensureCard が必ず16行作る）が、防御的に埋める
          return { position, zone: CENTER_POSITIONS.includes(position) ? 'CENTER' : 'OUTER', is_revealed: false, is_achieved: false, source: null, booth: null }
        }
        // is_revealed=0 のマスでは booth を必ず null にする（解放前に中身を漏らさない。絶対の制約）
        if (c.is_revealed === 0) {
          return {
            position: c.position,
            zone: c.zone,
            is_revealed: false,
            is_achieved: Boolean(c.is_achieved),
            source: c.source,
            booth: null,
          }
        }
        return {
          position: c.position,
          zone: c.zone,
          is_revealed: true,
          is_achieved: Boolean(c.is_achieved),
          source: c.source,
          booth: c.booth_id
            ? { id: c.booth_id, name: c.booth_name, manual_code: c.manual_code, description: c.booth_description }
            : null,
        }
      })

      const [unlockRows] = await app.db.query(
        `SELECT pair_key, released_positions, created_at
           FROM card_unlock_events
          WHERE card_id = ? AND pair_key <> 'PRESURVEY'
          ORDER BY created_at ASC`,
        [card.id],
      )
      const unlockEvents = (unlockRows as UnlockEventRow[]).map((e) => ({
        pair_key: e.pair_key,
        released_positions: e.released_positions.split(',').map((s) => Number(s.trim())),
        unlocked_at: `${String(e.created_at).replace(' ', 'T')}Z`,
      }))

      return sendOk(reply, {
        card_id: card.id,
        rating_scale: app.config.ratingScale,
        progress: {
          center_achieved: centerAchieved,
          center_total: CENTER_POSITIONS.length,
          revealed_cells: revealedCells,
          achieved_cells: achievedCells,
        },
        lines_completed: countCompletedLines(achieved),
        unlock_events: unlockEvents,
        cells,
      })
    },
  )
}
