import type { FastifyInstance } from 'fastify'
import { sendOk } from '../../../lib/response.js'
import { requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'

export async function adminRoutes(app: FastifyInstance) {
  const pre = [requireStaff, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/dashboard',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const [r1, r2, r3, r4, r5, r6, r7] = await Promise.all([
        app.db.query('SELECT COUNT(*) AS c FROM users WHERE event_id = ?', [eventId]),
        app.db.query('SELECT COUNT(*) AS c FROM check_ins WHERE event_id = ?', [eventId]),
        app.db.query(
          `SELECT b.id, b.name,
                  COUNT(DISTINCT ci.id) AS checkin_count,
                  AVG(br.rating) AS avg_rating
           FROM booths b
           LEFT JOIN check_ins ci ON ci.booth_id = b.id
           LEFT JOIN booth_ratings br ON br.booth_id = b.id
           WHERE b.event_id = ?
           GROUP BY b.id, b.name
           ORDER BY checkin_count DESC`,
          [eventId],
        ),
        app.db.query(
          `SELECT
             DATE_FORMAT(
               DATE_SUB(checked_in_at, INTERVAL MOD(MINUTE(checked_in_at), 10) MINUTE),
               '%H:%i'
             ) AS time_slot,
             COUNT(*) AS count
           FROM check_ins
           WHERE event_id = ?
           GROUP BY time_slot
           ORDER BY time_slot ASC`,
          [eventId],
        ),
        // ビンゴ段階解放の運用指標（docs/specs/bingo-dynamic-unlock/06-api/admin-api.md）。
        // participant のみ集計（E11）。card_unlock_events / recommendation_scores を参照する（D-8: status は持たない）。
        app.db.query(
          `SELECT
             (SELECT COUNT(*) FROM check_ins ci JOIN users u ON u.id = ci.user_id
                WHERE ci.event_id = ? AND u.role = 'participant') AS checkins,
             (SELECT COUNT(*) FROM booth_ratings br JOIN users u ON u.id = br.user_id
                WHERE br.event_id = ? AND u.role = 'participant') AS ratings
          `,
          [eventId, eventId],
        ),
        // カードごとの解放回数から「1回目/2回目/3回目まで到達した人数」を求める。
        // 2マス目達成で1ペア、3マス目達成で2ペア、4マス目達成で3ペアが同時に成立するため、
        // 累計ペア数のしきい値は 1 / 3 / 6 になる（unlock-pairs.md）。
        app.db.query(
          `SELECT k.id AS card_id, COUNT(*) AS pair_count
             FROM bingo_cards k
             JOIN card_unlock_events e ON e.card_id = k.id AND e.pair_key <> 'PRESURVEY'
            WHERE k.event_id = ?
            GROUP BY k.id`,
          [eventId],
        ),
        // 直近30分の解放のうち、推薦サービスが使えず fallback/self-heal になった割合
        app.db.query(
          `SELECT
             SUM(CASE WHEN strategy IN ('FALLBACK_COVERAGE','SELF_HEAL') THEN 1 ELSE 0 END) AS fallback_count,
             COUNT(*) AS total_count
             FROM card_unlock_events e
             JOIN bingo_cards k ON k.id = e.card_id
            WHERE k.event_id = ? AND e.pair_key <> 'PRESURVEY'
              AND e.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)`,
          [eventId],
        ),
      ])
      const p = Number((r1[0] as { c: number }[])[0]?.c ?? 0)
      const ch = Number((r2[0] as { c: number }[])[0]?.c ?? 0)
      const booths = (r3[0] as {
        id: string
        name: string
        checkin_count: number
        avg_rating: string | number | null
      }[]).map((b) => ({
        id: b.id,
        name: b.name,
        checkin_count: Number(b.checkin_count) || 0,
        avg_rating: b.avg_rating != null ? Number(b.avg_rating) : null,
      }))
      const checkin_timeline = (r4[0] as { time_slot: string; count: number }[]).map((t) => ({
        time_slot: t.time_slot,
        count: Number(t.count) || 0,
      }))
      const bingoRow = (r5[0] as { checkins: number; ratings: number }[])[0]
      const bingoCheckins = Number(bingoRow?.checkins) || 0
      const bingoRatings = Number(bingoRow?.ratings) || 0
      const ratingCollectionRate = bingoCheckins ? Math.round((bingoRatings / bingoCheckins) * 1000) / 1000 : 0

      const pairCounts = (r6[0] as { card_id: string; pair_count: number }[]).map((r) => Number(r.pair_count) || 0)
      const unlocks = {
        first: pairCounts.filter((n) => n >= 1).length,
        second: pairCounts.filter((n) => n >= 3).length,
        third: pairCounts.filter((n) => n >= 6).length,
      }

      const fallbackRow = (r7[0] as { fallback_count: number | null; total_count: number }[])[0]
      const fallbackCount = Number(fallbackRow?.fallback_count) || 0
      const fallbackTotal = Number(fallbackRow?.total_count) || 0
      const fallbackRateLast30Min = fallbackTotal ? Math.round((fallbackCount / fallbackTotal) * 1000) / 1000 : 0

      // フェーズ（current_phase など）は返さない。推薦エンジンの実際の稼働状態は
      // 中継エンドポイント GET /admin/events/:event_id/recommender/state が返す。
      // ここが返すのは DB の事実だけ（recommender-phase-linkage/02-dashboard-and-contract.md §1）。
      const bingo = {
        checkins: bingoCheckins,
        ratings: bingoRatings,
        rating_collection_rate: ratingCollectionRate,
        unlocks,
        fallback_rate_last_30min: fallbackRateLast30Min,
      }
      return sendOk(reply, {
        summary: {
          total_participants: p,
          total_checkins: ch,
          avg_checkins_per_user: p ? Math.round((ch / p) * 10) / 10 : 0,
        },
        booths,
        checkin_timeline,
        bingo,
      })
    },
  )
}
