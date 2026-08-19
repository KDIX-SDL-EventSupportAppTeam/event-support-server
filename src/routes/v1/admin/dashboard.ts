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
      const [r1, r2, r3, r4, r5] = await Promise.all([
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
        // ビンゴ段階解放の運用指標（docs/.sdd/06-api/admin-api.md §3）。participant のみ集計（E11）。
        app.db.query(
          `SELECT
             (SELECT COUNT(*) FROM bingo_cards WHERE event_id = ?) AS card_count,
             (SELECT COUNT(*) FROM bingo_cards WHERE event_id = ? AND status = 'UNLOCKED') AS unlocked_count,
             (SELECT COUNT(*) FROM check_ins ci JOIN users u ON u.id = ci.user_id
                WHERE ci.event_id = ? AND u.role = 'participant') AS participant_checkin_count,
             (SELECT COUNT(*) FROM booth_ratings br JOIN users u ON u.id = br.user_id
                WHERE br.event_id = ? AND u.role = 'participant') AS participant_rating_count,
             (SELECT COUNT(*) FROM check_ins ci
                JOIN bingo_cards k ON k.event_id = ci.event_id AND k.user_id = ci.user_id AND k.status = 'UNLOCKED'
                JOIN users u ON u.id = ci.user_id
                WHERE ci.event_id = ? AND ci.cell_id IS NULL AND u.role = 'participant'
                  AND ci.checked_in_at >= k.unlocked_at) AS off_card_after_unlock,
             (SELECT COUNT(*) FROM check_ins ci
                JOIN bingo_cards k ON k.event_id = ci.event_id AND k.user_id = ci.user_id AND k.status = 'UNLOCKED'
                JOIN users u ON u.id = ci.user_id
                WHERE ci.event_id = ? AND u.role = 'participant'
                  AND ci.checked_in_at >= k.unlocked_at) AS checkins_after_unlock,
             (SELECT AVG(TIMESTAMPDIFF(SECOND, created_at, unlocked_at))
                FROM bingo_cards WHERE event_id = ? AND status = 'UNLOCKED') AS avg_unlock_seconds
          `,
          [eventId, eventId, eventId, eventId, eventId, eventId, eventId],
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
      const bingoRow = (r5[0] as {
        card_count: number
        unlocked_count: number
        participant_checkin_count: number
        participant_rating_count: number
        off_card_after_unlock: number
        checkins_after_unlock: number
        avg_unlock_seconds: number | string | null
      }[])[0]
      const cardCount = Number(bingoRow?.card_count) || 0
      const unlockedCount = Number(bingoRow?.unlocked_count) || 0
      const participantCheckinCount = Number(bingoRow?.participant_checkin_count) || 0
      const participantRatingCount = Number(bingoRow?.participant_rating_count) || 0
      const offCardAfterUnlock = Number(bingoRow?.off_card_after_unlock) || 0
      const checkinsAfterUnlock = Number(bingoRow?.checkins_after_unlock) || 0
      const bingo = {
        card_count: cardCount,
        unlock_rate: cardCount ? Math.round((unlockedCount / cardCount) * 1000) / 1000 : 0,
        avg_unlock_seconds: bingoRow?.avg_unlock_seconds != null ? Math.round(Number(bingoRow.avg_unlock_seconds)) : null,
        rating_collection_rate: participantCheckinCount
          ? Math.round((participantRatingCount / participantCheckinCount) * 1000) / 1000
          : 0,
        off_card_visit_rate: checkinsAfterUnlock
          ? Math.round((offCardAfterUnlock / checkinsAfterUnlock) * 1000) / 1000
          : 0,
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
