import type { FastifyInstance } from 'fastify'
import { sendOk } from '../../../lib/response.js'
import { requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { countCompletedLines } from '../../../lib/bingo/lines.js'
import { calcCoinsEarned } from '../../../lib/gacha/coins.js'
import { fetchGachaSettings } from '../../../lib/gacha/settings.js'
import { mysqlUtcToIso } from '../../../lib/datetime.js'

/**
 * 運営スタッフ（manager/viewer）向けの当日モニタ。読み取り専用。
 *
 * `idx_gacha_event_used_at` で引く。参加者 API とは別クエリで、
 * 参加者側のレスポンスタイムに影響しないこと。
 *
 * 仕様: docs/specs/gacha-and-award/04-api/organizer-api.md
 */
export async function adminGachaRoutes(app: FastifyInstance) {
  const pre = [requireStaff, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/gacha/stats',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id

      const [usedAgg] = await app.db.query(
        `SELECT COUNT(*) AS total_used, COUNT(DISTINCT user_id) AS users_who_used
           FROM gacha_coin_uses
          WHERE event_id = ?`,
        [eventId],
      )
      const agg = (usedAgg as { total_used: number; users_who_used: number }[])[0]
      const totalUsed = Number(agg?.total_used ?? 0)
      const usersWhoUsed = Number(agg?.users_who_used ?? 0)

      const [hourRows] = await app.db.query(
        `SELECT DATE_FORMAT(used_at, '%Y-%m-%d %H:00:00') AS hour, COUNT(*) AS count
           FROM gacha_coin_uses
          WHERE event_id = ?
          GROUP BY hour
          ORDER BY hour`,
        [eventId],
      )
      const usedByHour = (hourRows as { hour: string; count: number }[]).map((r) => ({
        hour: mysqlUtcToIso(r.hour),
        count: Number(r.count),
      }))

      // users_with_coins: 換算後 earned > 0 の参加者数。
      // 参加者 API とは独立の集計クエリ（ライン計算は bingo の純関数に委ねる）。
      const settings = await fetchGachaSettings(app.db, eventId)
      const [cellRows] = await app.db.query(
        `SELECT c.user_id AS user_id, cell.position AS position
           FROM bingo_cards c
           JOIN bingo_cells cell ON cell.card_id = c.id AND cell.is_achieved = 1
          WHERE c.event_id = ?`,
        [eventId],
      )
      const achievedByUser = new Map<string, Set<number>>()
      for (const row of cellRows as { user_id: string; position: number }[]) {
        let set = achievedByUser.get(row.user_id)
        if (!set) {
          set = new Set<number>()
          achievedByUser.set(row.user_id, set)
        }
        set.add(Number(row.position))
      }
      let usersWithCoins = 0
      for (const positions of achievedByUser.values()) {
        if (calcCoinsEarned(countCompletedLines(positions), settings) > 0) usersWithCoins++
      }
      // bonus_coins > 0 のときはカードを持つ全員が earned > 0。カード未達成者も数える。
      if (settings.bonusCoins > 0) {
        const [cardCount] = await app.db.query(
          `SELECT COUNT(*) AS c FROM bingo_cards WHERE event_id = ?`,
          [eventId],
        )
        usersWithCoins = Number((cardCount as { c: number }[])[0]?.c ?? 0)
      }

      return sendOk(reply, {
        total_used: totalUsed,
        users_with_coins: usersWithCoins,
        users_who_used: usersWhoUsed,
        used_by_hour: usedByHour,
      })
    },
  )
}
