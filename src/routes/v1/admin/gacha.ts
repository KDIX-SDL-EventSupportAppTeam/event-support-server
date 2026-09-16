import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireManager, requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { countCompletedLines } from '../../../lib/bingo/lines.js'
import { calcCoinsEarned } from '../../../lib/gacha/coins.js'
import { fetchGachaSettings } from '../../../lib/gacha/settings.js'
import { insertAuditLog } from '../../../lib/audit.js'
import { mysqlUtcToIso } from '../../../lib/datetime.js'

/**
 * 運営スタッフ（manager/viewer）向けの当日モニタ。
 *
 * - `GET /gacha/stats` は読み取り専用（viewer 可）
 * - `PATCH /gacha/enabled` は当日の緊急停止／再開（manager 限定・issue #122）
 *
 * 参加者 API とは別クエリで、参加者側のレスポンスタイムに影響しないこと。
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

      // users_with_coins / total_earned: 換算後の「参加者」ぶんの集計。
      // 参加者 API とは独立の集計クエリ（ライン計算は bingo の純関数に委ねる）。
      // 運営スタッフ・出展者のカードは数に入れない（当日の配布実績を見るための指標のため）。
      const settings = await fetchGachaSettings(app.db, eventId)
      const [cellRows] = await app.db.query(
        `SELECT c.user_id AS user_id, cell.position AS position
           FROM bingo_cards c
           JOIN users u ON u.id = c.user_id AND (u.role = 'participant' OR u.role IS NULL)
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
      let totalEarned = 0
      for (const positions of achievedByUser.values()) {
        const earned = calcCoinsEarned(countCompletedLines(positions), settings)
        if (earned > 0) usersWithCoins++
        totalEarned += earned
      }
      // bonus_coins > 0 のときはカードを持つ参加者全員が earned > 0。マス未達成者も数える。
      if (settings.bonusCoins > 0) {
        const [cardCount] = await app.db.query(
          `SELECT COUNT(*) AS c
             FROM bingo_cards c
             JOIN users u ON u.id = c.user_id AND (u.role = 'participant' OR u.role IS NULL)
            WHERE c.event_id = ?`,
          [eventId],
        )
        const cards = Number((cardCount as { c: number }[])[0]?.c ?? 0)
        usersWithCoins = cards
        // achievedByUser に居ない（マス未達成の）カード保持者ぶんの bonus を足す
        totalEarned += settings.bonusCoins * Math.max(0, cards - achievedByUser.size)
      }

      return sendOk(reply, {
        is_enabled: settings.isEnabled,
        total_used: totalUsed,
        total_earned: totalEarned,
        users_with_coins: usersWithCoins,
        users_who_used: usersWhoUsed,
        used_by_hour: usedByHour,
      })
    },
  )

  // 当日の緊急停止／再開（issue #122）。is_enabled だけを変える。
  // organizer API（gacha/settings の4項目まとめ PUT）は会場にいる manager が呼べないため、
  // manager 限定のこの1項目 PATCH を別に用意する。
  const enabledBody = z.object({ is_enabled: z.boolean() })

  app.patch<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/gacha/enabled',
    { preHandler: [requireManager, requireEventMatchesJwt] },
    async (req, reply) => {
      const eventId = req.params.event_id
      const parsed = enabledBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }

      // 行が無いイベントは fetchGachaSettings の既定値を土台に upsert する。
      // coins_per_line / max_coins / bonus_coins は触らない（換算規則を巻き込まない）。
      const before = await fetchGachaSettings(app.db, eventId)
      await app.db.execute(
        `INSERT INTO gacha_settings (event_id, is_enabled, coins_per_line, max_coins, bonus_coins)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)`,
        [
          eventId,
          parsed.data.is_enabled ? 1 : 0,
          before.coinsPerLine,
          before.maxCoins,
          before.bonusCoins,
        ],
      )
      const after = await fetchGachaSettings(app.db, eventId)

      await insertAuditLog(app.db, {
        eventId,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'gacha.enabled.update',
        targetType: 'gacha_settings',
        targetId: eventId,
        detail: { before: before.isEnabled, after: after.isEnabled },
      })

      return sendOk(reply, { is_enabled: after.isEnabled })
    },
  )
}
