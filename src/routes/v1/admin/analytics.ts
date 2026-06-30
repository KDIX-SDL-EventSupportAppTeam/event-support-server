import type { FastifyInstance } from 'fastify'
import { parseJsonStringArray } from '../../../lib/json-array.js'
import { sendOk } from '../../../lib/response.js'
import { requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'

type RecRow = {
  offered_booth_ids: unknown
  selected_booth_id: string | null
  algorithm: string
  user_id: string
  created_at: string
}

function aggregateRecommendations(rows: RecRow[]) {
  const boothOfferedCount: Record<string, number> = {}
  const boothSelectedCount: Record<string, number> = {}
  let selectedCount = 0
  let openCount = 0
  let algorithm = 'mab'

  for (const row of rows) {
    algorithm = row.algorithm || algorithm
    const offered = parseJsonStringArray(row.offered_booth_ids)
    for (const boothId of offered) {
      boothOfferedCount[boothId] = (boothOfferedCount[boothId] ?? 0) + 1
    }
    if (row.selected_booth_id) {
      selectedCount++
      boothSelectedCount[row.selected_booth_id] =
        (boothSelectedCount[row.selected_booth_id] ?? 0) + 1
    } else {
      openCount++
    }
  }

  return {
    boothOfferedCount,
    boothSelectedCount,
    selectedCount,
    openCount,
    algorithm,
    total: rows.length,
  }
}

function toIsoDatetime(v: string): string {
  return `${String(v).replace(' ', 'T')}Z`
}

function rate(selected: number, offered: number): number | null {
  if (!offered) return null
  return Math.round((selected / offered) * 1000) / 10
}

/** 評価分布 {1..5: 件数} から平均評価を算出する（評価なしは null） */
function avgFromDistribution(dist: Record<number, number>): number | null {
  let sum = 0
  let count = 0
  for (const star of [1, 2, 3, 4, 5]) {
    const n = dist[star] ?? 0
    sum += star * n
    count += n
  }
  return count > 0 ? Math.round((sum / count) * 100) / 100 : null
}

export async function adminAnalyticsRoutes(app: FastifyInstance) {
  const pre = [requireStaff, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/analytics/booths',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id

      const [[boothRows], [tagRows], [ratingRows], [recRows]] = await Promise.all([
        // booth_ratings はここで JOIN しない。check_ins と同時に LEFT JOIN すると
        // 直積でメソッド別カウントが評価件数分だけ水増しされるため。
        // 平均評価は下の ratingRows（評価分布）から算出する。
        app.db.query(
          `SELECT b.id, b.name, b.manual_code, b.created_at,
                  c.id AS category_id, c.name AS category_name,
                  COUNT(ci.id) AS checkin_count,
                  SUM(CASE WHEN ci.checkin_method = 'qr' THEN 1 ELSE 0 END) AS qr_count,
                  SUM(CASE WHEN ci.checkin_method = 'manual' THEN 1 ELSE 0 END) AS manual_count
           FROM booths b
           LEFT JOIN categories c ON c.id = b.category_id
           LEFT JOIN check_ins ci ON ci.booth_id = b.id
           WHERE b.event_id = ?
           GROUP BY b.id, b.name, b.manual_code, b.created_at, c.id, c.name
           ORDER BY b.manual_code ASC`,
          [eventId],
        ),
        app.db.query(
          `SELECT bt.booth_id, bt.tag
           FROM booth_tags bt
           INNER JOIN booths b ON b.id = bt.booth_id
           WHERE b.event_id = ?`,
          [eventId],
        ),
        app.db.query(
          `SELECT booth_id, rating, COUNT(*) AS cnt
           FROM booth_ratings WHERE event_id = ?
           GROUP BY booth_id, rating`,
          [eventId],
        ),
        app.db.query(
          `SELECT offered_booth_ids, selected_booth_id, algorithm, user_id, created_at
           FROM recommendations WHERE event_id = ?`,
          [eventId],
        ),
      ])

      const tagsByBooth = new Map<string, string[]>()
      for (const t of tagRows as { booth_id: string; tag: string }[]) {
        const list = tagsByBooth.get(t.booth_id) ?? []
        list.push(t.tag)
        tagsByBooth.set(t.booth_id, list)
      }

      const ratingDistByBooth = new Map<string, Record<number, number>>()
      for (const r of ratingRows as { booth_id: string; rating: number; cnt: number }[]) {
        const dist = ratingDistByBooth.get(r.booth_id) ?? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
        dist[r.rating as 1 | 2 | 3 | 4 | 5] = Number(r.cnt) || 0
        ratingDistByBooth.set(r.booth_id, dist)
      }

      const recAgg = aggregateRecommendations(recRows as RecRow[])

      const booths = (boothRows as {
        id: string
        name: string
        manual_code: string
        created_at: string
        category_id: string | null
        category_name: string | null
        checkin_count: number
        qr_count: number
        manual_count: number
      }[]).map((b) => {
        const offered = recAgg.boothOfferedCount[b.id] ?? 0
        const selected = recAgg.boothSelectedCount[b.id] ?? 0
        const dist = ratingDistByBooth.get(b.id) ?? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
        return {
          id: b.id,
          name: b.name,
          manual_code: b.manual_code,
          created_at: toIsoDatetime(b.created_at),
          category:
            b.category_id && b.category_name
              ? { id: b.category_id, name: b.category_name }
              : null,
          tags: tagsByBooth.get(b.id) ?? [],
          checkin_count: Number(b.checkin_count) || 0,
          checkin_by_method: {
            qr: Number(b.qr_count) || 0,
            manual: Number(b.manual_count) || 0,
          },
          avg_rating: avgFromDistribution(dist),
          rating_distribution: dist,
          recommendation_offered_count: offered,
          recommendation_selected_count: selected,
          recommendation_acceptance_rate: rate(selected, offered),
        }
      })

      const categoryMap = new Map<
        string | null,
        { category_id: string | null; category_name: string; total_checkins: number; ratings: number[]; booth_count: number }
      >()

      for (const b of booths) {
        const key = b.category?.id ?? null
        const name = b.category?.name ?? '未分類'
        const entry = categoryMap.get(key) ?? {
          category_id: key,
          category_name: name,
          total_checkins: 0,
          ratings: [],
          booth_count: 0,
        }
        entry.total_checkins += b.checkin_count
        entry.booth_count++
        if (b.avg_rating != null) entry.ratings.push(b.avg_rating)
        categoryMap.set(key, entry)
      }

      const category_summary = [...categoryMap.values()].map((c) => ({
        category_id: c.category_id,
        category_name: c.category_name,
        total_checkins: c.total_checkins,
        avg_rating:
          c.ratings.length > 0
            ? Math.round((c.ratings.reduce((a, v) => a + v, 0) / c.ratings.length) * 10) / 10
            : null,
        booth_count: c.booth_count,
      }))

      return sendOk(reply, { booths, category_summary })
    },
  )

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/analytics/participants',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id

      const [[userRows], [firstCheckinRows], [visitRows], [rollingRows], [surveyRows]] =
        await Promise.all([
          app.db.query(
            `SELECT u.id, u.display_name, u.email, u.role, u.created_at,
                    COUNT(ci.id) AS total_checkins
             FROM users u
             LEFT JOIN check_ins ci ON ci.user_id = u.id
             WHERE u.event_id = ?
             GROUP BY u.id, u.display_name, u.email, u.role, u.created_at
             ORDER BY u.created_at DESC`,
            [eventId],
          ),
          app.db.query(
            `SELECT user_id, MIN(checked_in_at) AS first_checkin_at
             FROM check_ins WHERE event_id = ?
             GROUP BY user_id`,
            [eventId],
          ),
          app.db.query(
            `SELECT ci.user_id, b.id AS booth_id, b.name AS booth_name
             FROM check_ins ci
             INNER JOIN booths b ON b.id = ci.booth_id
             WHERE ci.event_id = ?
             ORDER BY ci.checked_in_at ASC`,
            [eventId],
          ),
          app.db.query(
            `SELECT
               SUM(CASE WHEN checked_in_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE) THEN 1 ELSE 0 END) AS rolling_30min,
               SUM(CASE WHEN checked_in_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE) THEN 1 ELSE 0 END) AS rolling_10min,
               SUM(CASE WHEN checked_in_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 MINUTE)
                         AND checked_in_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE) THEN 1 ELSE 0 END) AS rolling_30min_prev
             FROM check_ins WHERE event_id = ?`,
            [eventId],
          ),
          app.db.query(
            `SELECT age_range, occupation, industry FROM user_survey_answers WHERE event_id = ?`,
            [eventId],
          ),
        ])

      const firstCheckinMap = new Map<string, string>()
      for (const r of firstCheckinRows as { user_id: string; first_checkin_at: string }[]) {
        firstCheckinMap.set(r.user_id, toIsoDatetime(r.first_checkin_at))
      }

      const visitsByUser = new Map<string, { id: string; name: string }[]>()
      for (const v of visitRows as { user_id: string; booth_id: string; booth_name: string }[]) {
        const list = visitsByUser.get(v.user_id) ?? []
        if (!list.some((b) => b.id === v.booth_id)) {
          list.push({ id: v.booth_id, name: v.booth_name })
        }
        visitsByUser.set(v.user_id, list)
      }

      const participants = (userRows as {
        id: string
        display_name: string | null
        email: string
        role: string
        created_at: string
        total_checkins: number
      }[]).map((u) => ({
        id: u.id,
        display_name: u.display_name ?? '',
        email: u.email,
        role: u.role,
        registered_at: toIsoDatetime(u.created_at),
        first_checkin_at: firstCheckinMap.get(u.id) ?? null,
        total_checkins: Number(u.total_checkins) || 0,
        visited_booths: visitsByUser.get(u.id) ?? [],
      }))

      const participantOnly = participants.filter((p) => p.role === 'participant')
      const checkedIn = participantOnly.filter((p) => p.total_checkins > 0).length

      const slotCounts = new Map<string, number>()
      for (const p of participantOnly) {
        if (!p.first_checkin_at) continue
        const d = new Date(p.first_checkin_at)
        const slot = `${String(d.getUTCHours()).padStart(2, '0')}:${String(Math.floor(d.getUTCMinutes() / 10) * 10).padStart(2, '0')}`
        slotCounts.set(slot, (slotCounts.get(slot) ?? 0) + 1)
      }
      const sortedSlots = [...slotCounts.entries()].sort(([a], [b]) => a.localeCompare(b))
      let cumulative = 0
      const joining_timeline = sortedSlots.map(([time_slot, new_participants]) => {
        cumulative += new_participants
        return { time_slot, new_participants, cumulative }
      })

      const distMap = new Map<number, number>()
      for (const p of participantOnly) {
        const c = p.total_checkins
        distMap.set(c, (distMap.get(c) ?? 0) + 1)
      }
      const checkin_distribution = [...distMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([checkin_count, num_users]) => ({ checkin_count, num_users }))

      const rolling = (rollingRows as {
        rolling_30min: number
        rolling_10min: number
        rolling_30min_prev: number
      }[])[0]

      const countField = (field: 'age_range' | 'occupation' | 'industry') => {
        const counts: Record<string, number> = {}
        for (const s of surveyRows as Record<string, string | null>[]) {
          const val = s[field]
          if (val) counts[val] = (counts[val] ?? 0) + 1
        }
        return counts
      }

      const surveyAnswers = surveyRows as { age_range: string | null; occupation: string | null; industry: string | null }[]
      const survey_distribution =
        surveyAnswers.length > 0
          ? {
              age_range: countField('age_range'),
              occupation: countField('occupation'),
              industry: countField('industry'),
            }
          : null

      return sendOk(reply, {
        summary: {
          total: participantOnly.length,
          checked_in: checkedIn,
          not_checked_in: participantOnly.length - checkedIn,
          rolling_30min: Number(rolling?.rolling_30min) || 0,
          rolling_10min: Number(rolling?.rolling_10min) || 0,
          rolling_30min_prev: Number(rolling?.rolling_30min_prev) || 0,
        },
        joining_timeline,
        checkin_distribution,
        participants,
        survey_distribution,
      })
    },
  )

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/analytics/checkins',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id

      const [[timelineRows], [methodRows], [recentRows], [totalRows]] = await Promise.all([
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
        app.db.query(
          `SELECT checkin_method, COUNT(*) AS cnt FROM check_ins WHERE event_id = ? GROUP BY checkin_method`,
          [eventId],
        ),
        app.db.query(
          `SELECT ci.id, b.name AS booth_name, u.display_name AS user_display_name,
                  ci.checkin_method AS method, ci.checked_in_at
           FROM check_ins ci
           INNER JOIN booths b ON b.id = ci.booth_id
           INNER JOIN users u ON u.id = ci.user_id
           WHERE ci.event_id = ?
           ORDER BY ci.checked_in_at DESC
           LIMIT 20`,
          [eventId],
        ),
        app.db.query(`SELECT COUNT(*) AS c FROM check_ins WHERE event_id = ?`, [eventId]),
      ])

      let cumulative = 0
      let peak_slot: string | null = null
      let peak_count = 0
      const timeline = (timelineRows as { time_slot: string; count: number }[]).map((t) => {
        const count = Number(t.count) || 0
        cumulative += count
        if (count > peak_count) {
          peak_count = count
          peak_slot = t.time_slot
        }
        return { time_slot: t.time_slot, count, cumulative }
      })

      const by_method = { qr: 0, manual: 0 }
      for (const m of methodRows as { checkin_method: string; cnt: number }[]) {
        if (m.checkin_method === 'qr') by_method.qr = Number(m.cnt) || 0
        if (m.checkin_method === 'manual') by_method.manual = Number(m.cnt) || 0
      }

      const recent = (recentRows as {
        id: string
        booth_name: string
        user_display_name: string | null
        method: string
        checked_in_at: string
      }[]).map((r) => ({
        id: r.id,
        booth_name: r.booth_name,
        user_display_name: r.user_display_name ?? '',
        method: r.method,
        checked_in_at: toIsoDatetime(r.checked_in_at),
      }))

      return sendOk(reply, {
        timeline,
        by_method,
        peak_slot,
        peak_count,
        total: Number((totalRows as { c: number }[])[0]?.c) || 0,
        recent,
      })
    },
  )

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/analytics/recommendations',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id

      const [[recRows], [boothRows], [checkinRows]] = await Promise.all([
        app.db.query(
          `SELECT id, offered_booth_ids, selected_booth_id, algorithm, user_id, created_at
           FROM recommendations WHERE event_id = ?`,
          [eventId],
        ),
        app.db.query(`SELECT id, name FROM booths WHERE event_id = ?`, [eventId]),
        app.db.query(
          `SELECT user_id, booth_id, checked_in_at FROM check_ins WHERE event_id = ?`,
          [eventId],
        ),
      ])

      const boothNameMap = new Map(
        (boothRows as { id: string; name: string }[]).map((b) => [b.id, b.name]),
      )

      const recs = recRows as RecRow[]
      const recAgg = aggregateRecommendations(recs)

      const by_booth = [...new Set([
        ...Object.keys(recAgg.boothOfferedCount),
        ...Object.keys(recAgg.boothSelectedCount),
      ])]
        .map((booth_id) => {
          const offered = recAgg.boothOfferedCount[booth_id] ?? 0
          const selected = recAgg.boothSelectedCount[booth_id] ?? 0
          return {
            booth_id,
            booth_name: boothNameMap.get(booth_id) ?? booth_id,
            offered_count: offered,
            selected_count: selected,
            acceptance_rate: rate(selected, offered),
          }
        })
        .sort((a, b) => b.offered_count - a.offered_count)

      // ブース遷移（Node.js で consecutive check-ins を集計）
      const checkinsByUser = new Map<string, { booth_id: string; checked_in_at: string }[]>()
      for (const c of checkinRows as { user_id: string; booth_id: string; checked_in_at: string }[]) {
        const list = checkinsByUser.get(c.user_id) ?? []
        list.push({ booth_id: c.booth_id, checked_in_at: c.checked_in_at })
        checkinsByUser.set(c.user_id, list)
      }

      const transitionCounts = new Map<string, number>()
      for (const list of checkinsByUser.values()) {
        list.sort((a, b) => a.checked_in_at.localeCompare(b.checked_in_at))
        for (let i = 0; i < list.length - 1; i++) {
          const from = list[i].booth_id
          const to = list[i + 1].booth_id
          if (from === to) continue
          const key = `${from}\0${to}`
          transitionCounts.set(key, (transitionCounts.get(key) ?? 0) + 1)
        }
      }

      const transitions = [...transitionCounts.entries()]
        .map(([key, count]) => {
          const [from_booth_id, to_booth_id] = key.split('\0')
          return {
            from_booth_id,
            from_booth_name: boothNameMap.get(from_booth_id) ?? from_booth_id,
            to_booth_id,
            to_booth_name: boothNameMap.get(to_booth_id) ?? to_booth_id,
            count,
          }
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 20)

      // 推薦選択 → チェックインコンバージョン
      const checkinsByUserBooth = new Map<string, string[]>()
      for (const c of checkinRows as { user_id: string; booth_id: string; checked_in_at: string }[]) {
        const key = `${c.user_id}\0${c.booth_id}`
        const list = checkinsByUserBooth.get(key) ?? []
        list.push(c.checked_in_at)
        checkinsByUserBooth.set(key, list)
      }

      let selected_then_checkedin = 0
      const minutesList: number[] = []
      for (const r of recs) {
        if (!r.selected_booth_id) continue
        const key = `${r.user_id}\0${r.selected_booth_id}`
        const times = checkinsByUserBooth.get(key) ?? []
        const recTime = new Date(toIsoDatetime(r.created_at)).getTime()
        const after = times
          .map((t) => new Date(toIsoDatetime(t)).getTime())
          .filter((t) => t >= recTime)
        if (after.length > 0) {
          selected_then_checkedin++
          minutesList.push(Math.round((Math.min(...after) - recTime) / 60000))
        }
      }

      const selected_total = recAgg.selectedCount
      const conversion_rate = selected_total ? rate(selected_then_checkedin, selected_total) : null
      const avg_minutes_to_checkin =
        minutesList.length > 0
          ? Math.round(minutesList.reduce((a, v) => a + v, 0) / minutesList.length)
          : null

      return sendOk(reply, {
        summary: {
          total_recommendations: recAgg.total,
          selected_count: recAgg.selectedCount,
          acceptance_rate: recAgg.total ? rate(recAgg.selectedCount, recAgg.total) ?? 0 : 0,
          open_count: recAgg.openCount,
          algorithm: recAgg.algorithm,
        },
        by_booth,
        transitions,
        conversion: {
          selected_then_checkedin,
          selected_total,
          conversion_rate,
          avg_minutes_to_checkin,
        },
      })
    },
  )
}
