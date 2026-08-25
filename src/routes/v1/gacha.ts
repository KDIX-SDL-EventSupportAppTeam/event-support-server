import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'
import { ensureCard } from '../../lib/bingo/ensureCard.js'
import { countCompletedLines } from '../../lib/bingo/lines.js'

/** ビンゴのライン数からコイン数へ換算する既定の上限。ガチャ本体の実装までの暫定値。 */
const MAX_COINS = 10

/**
 * ガチャコイン API の器のみ。docs/specs/bingo-dynamic-unlock/06-api/participant-api.md
 *
 * ビンゴ側は lines_completed を提供するだけで、コインへの換算・ガチャ本体の抽選ロジックは
 * ここでは実装しない（D-5: ビンゴのモジュールはガチャのエンドポイントを知らない）。
 */
export async function gachaRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/gacha/coins',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub

      const card = await ensureCard(app.db, eventId, uid)
      const [rows] = await app.db.query(
        `SELECT position FROM bingo_cells WHERE card_id = ? AND is_achieved = 1`,
        [card.id],
      )
      const achieved = new Set((rows as { position: number }[]).map((r) => r.position))
      const linesCompleted = countCompletedLines(achieved)

      const [usedRows] = await app.db.query(
        `SELECT COUNT(*) AS c FROM gacha_coin_uses WHERE event_id = ? AND user_id = ?`,
        [eventId, uid],
      )
      const used = Number((usedRows as { c: number }[])[0]?.c ?? 0)

      const earned = Math.min(linesCompleted, MAX_COINS)
      const available = Math.max(0, earned - used)

      return sendOk(reply, { lines_completed: linesCompleted, earned, used, available, max: MAX_COINS })
    },
  )

  app.post<{ Params: { event_id: string } }>(
    '/events/:event_id/gacha/coins/use',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub

      const id = randomUUID()
      await app.db.execute(
        `INSERT INTO gacha_coin_uses (id, event_id, user_id) VALUES (?,?,?)`,
        [id, eventId, uid],
      )

      const card = await ensureCard(app.db, eventId, uid)
      const [rows] = await app.db.query(
        `SELECT position FROM bingo_cells WHERE card_id = ? AND is_achieved = 1`,
        [card.id],
      )
      const achieved = new Set((rows as { position: number }[]).map((r) => r.position))
      const linesCompleted = countCompletedLines(achieved)

      const [usedRows] = await app.db.query(
        `SELECT COUNT(*) AS c FROM gacha_coin_uses WHERE event_id = ? AND user_id = ?`,
        [eventId, uid],
      )
      const used = Number((usedRows as { c: number }[])[0]?.c ?? 0)

      const earned = Math.min(linesCompleted, MAX_COINS)
      const available = Math.max(0, earned - used)

      return sendOk(reply, { lines_completed: linesCompleted, earned, used, available, max: MAX_COINS })
    },
  )
}
