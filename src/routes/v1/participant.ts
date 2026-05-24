import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isoToMysqlUtc, utcMysqlNow } from '../../lib/datetime.js'
import { sendFail, sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'

const fixedQuestions = [
  { key: 'age_range', label: '年齢層', options: ['10代', '20代', '30代', '40代', '50代以上'] },
  { key: 'occupation', label: '職業', options: ['学生', '会社員', '経営者', 'その他'] },
  { key: 'industry', label: '業種', options: ['IT', '製造', '金融', '医療', 'その他'] },
] as const

const surveyAnswersBody = z.object({
  age_range: z.string().optional(),
  occupation: z.string().optional(),
  industry: z.string().optional(),
  custom_answers: z.record(z.string()).optional(),
})

const checkinBody = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('qr'),
    booth_id: z.string().uuid(),
    checked_in_at: z.string(),
  }),
  z.object({
    method: z.literal('manual'),
    manual_code: z.string().min(1).max(6),
    checked_in_at: z.string(),
  }),
])

const ratingBody = z.object({ rating: z.number().int().min(1).max(5) })

const selectRecBody = z.object({ selected_booth_id: z.string().uuid() })

export async function participantRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/survey/questions',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const [rows] = await app.db.query(
        `SELECT id, question_text, options, display_order, is_required
         FROM survey_questions WHERE event_id = ? ORDER BY display_order ASC, id ASC`,
        [eventId],
      )
      const custom = (rows as {
        id: string
        question_text: string
        options: unknown
        display_order: number | null
        is_required: boolean | number | null
      }[]).map((r) => {
        let opts: string[] = []
        if (Array.isArray(r.options)) opts = r.options as string[]
        else if (typeof r.options === 'string') {
          try {
            const p = JSON.parse(r.options) as unknown
            if (Array.isArray(p)) opts = p as string[]
          } catch {
            opts = []
          }
        }
        return {
          id: r.id,
          question_text: r.question_text,
          options: opts,
          display_order: r.display_order,
          is_required: Boolean(r.is_required),
        }
      })

      return sendOk(reply, {
        fixed_questions: fixedQuestions.map((q) => ({ ...q })),
        custom_questions: custom,
      })
    },
  )

  app.post<{ Params: { event_id: string } }>(
    '/events/:event_id/survey/answers',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = surveyAnswersBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub
      const { age_range, occupation, industry, custom_answers } = parsed.data
      const id = randomUUID()
      await app.db.execute(
        `INSERT INTO user_survey_answers (id, user_id, event_id, age_range, occupation, industry, custom_answers)
         VALUES (?,?,?,?,?,?,?)`,
        [
          id,
          uid,
          eventId,
          age_range ?? null,
          occupation ?? null,
          industry ?? null,
          custom_answers ? JSON.stringify(custom_answers) : null,
        ],
      )
      return sendOk(reply, { survey_answer_id: id })
    },
  )

  app.get<{ Params: { event_id: string }; Querystring: { category_id?: string } }>(
    '/events/:event_id/booths',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub
      const cat = req.query.category_id
      const boothParams: string[] = [uid, eventId]
      let catSql = ''
      if (cat) {
        catSql = ' AND b.category_id = ? '
        boothParams.push(cat)
      }
      const [booths] = await app.db.query(
        `SELECT b.id, b.name, b.description, b.manual_code, b.category_id, c.name AS category_name,
          (SELECT COUNT(*) FROM check_ins ci WHERE ci.booth_id = b.id) AS checkin_count,
          (SELECT AVG(br.rating) FROM booth_ratings br WHERE br.booth_id = b.id) AS avg_rating,
          EXISTS(SELECT 1 FROM check_ins ci WHERE ci.booth_id = b.id AND ci.user_id = ?) AS is_checked_in
         FROM booths b
         LEFT JOIN categories c ON c.id = b.category_id
         WHERE b.event_id = ? ${catSql}
         ORDER BY b.name ASC`,
        boothParams,
      )

      const list = booths as {
        id: string
        name: string
        description: string | null
        manual_code: string | null
        category_id: string | null
        category_name: string | null
        checkin_count: number
        avg_rating: string | number | null
        is_checked_in: number | boolean
      }[]

      const ids = list.map((b) => b.id)
      const tagMap = new Map<string, string[]>()
      if (ids.length) {
        const [tags] = await app.db.query(
          `SELECT booth_id, tag FROM booth_tags WHERE booth_id IN (${ids.map(() => '?').join(',')})`,
          ids,
        )
        for (const t of tags as { booth_id: string; tag: string }[]) {
          const arr = tagMap.get(t.booth_id) ?? []
          arr.push(t.tag)
          tagMap.set(t.booth_id, arr)
        }
      }

      return sendOk(reply, {
        booths: list.map((b) => ({
          id: b.id,
          name: b.name,
          manual_code: b.manual_code ?? null,
          description: b.description ?? '',
          category: b.category_id
            ? { id: b.category_id, name: b.category_name ?? '' }
            : null,
          tags: tagMap.get(b.id) ?? [],
          labels: [] as string[],
          checkin_count: Number(b.checkin_count) || 0,
          avg_rating: b.avg_rating != null ? Number(b.avg_rating) : null,
          is_checked_in: Boolean(b.is_checked_in),
        })),
      })
    },
  )

  app.get<{ Params: { event_id: string; booth_id: string } }>(
    '/events/:event_id/booths/:booth_id',
    { preHandler: pre },
    async (req, reply) => {
      const { event_id, booth_id } = req.params
      const uid = req.jwtUser!.sub
      const [rows] = await app.db.query(
        `SELECT b.id, b.name,
          (SELECT COUNT(*) FROM check_ins ci WHERE ci.booth_id = b.id) AS checkin_count_total,
          (SELECT COUNT(*) FROM check_ins ci WHERE ci.booth_id = b.id AND ci.checked_in_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)) AS checkin_count_last_10min,
          (SELECT COUNT(*) FROM check_ins ci WHERE ci.booth_id = b.id AND ci.checked_in_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)) AS checkin_count_last_30min,
          (SELECT AVG(br.rating) FROM booth_ratings br WHERE br.booth_id = b.id) AS avg_rating,
          EXISTS(SELECT 1 FROM check_ins ci WHERE ci.booth_id = b.id AND ci.user_id = ?) AS is_checked_in
         FROM booths b WHERE b.id = ? AND b.event_id = ? LIMIT 1`,
        [uid, booth_id, event_id],
      )
      const b = (rows as Record<string, unknown>[])[0]
      if (!b) {
        return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
      }
      return sendOk(reply, {
        id: b.id,
        name: b.name,
        labels: [] as string[],
        stats: {
          checkin_count_total: Number(b.checkin_count_total) || 0,
          checkin_count_last_10min: Number(b.checkin_count_last_10min) || 0,
          checkin_count_last_30min: Number(b.checkin_count_last_30min) || 0,
          avg_rating: b.avg_rating != null ? Number(b.avg_rating) : null,
          avg_stay_minutes: null as number | null,
        },
        is_checked_in: Boolean(b.is_checked_in),
      })
    },
  )

  app.post<{ Params: { event_id: string } }>(
    '/events/:event_id/checkins',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = checkinBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub
      const body = parsed.data
      let boothId: string
      let method: 'qr' | 'manual'
      let checkedMysql: string
      try {
        checkedMysql = isoToMysqlUtc(body.checked_in_at)
      } catch {
        return sendFail(reply, 422, 'VALIDATION_ERROR', 'checked_in_at が不正です')
      }

      if (body.method === 'qr') {
        method = 'qr'
        boothId = body.booth_id
        const [b] = await app.db.query(
          'SELECT id, name FROM booths WHERE id = ? AND event_id = ? LIMIT 1',
          [boothId, eventId],
        )
        const row = (b as { id: string; name: string }[])[0]
        if (!row) {
          return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
        }
      } else {
        method = 'manual'
        const code = body.manual_code.trim().toUpperCase()
        const [b] = await app.db.query(
          'SELECT id, name FROM booths WHERE event_id = ? AND UPPER(manual_code) = ? LIMIT 1',
          [eventId, code],
        )
        const row = (b as { id: string; name: string }[])[0]
        if (!row) {
          return sendFail(reply, 404, 'NOT_FOUND', '手動コードに一致するブースがありません')
        }
        boothId = row.id
      }

      const id = randomUUID()
      const synced = utcMysqlNow()
      try {
        await app.db.execute(
          `INSERT INTO check_ins (id, user_id, booth_id, event_id, checkin_method, checked_in_at, synced_at)
           VALUES (?,?,?,?,?,?,?)`,
          [id, uid, boothId, eventId, method, checkedMysql, synced],
        )
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === 'ER_DUP_ENTRY') {
          return sendFail(reply, 409, 'CONFLICT', 'このブースには既にチェックイン済みです')
        }
        throw e
      }

      const [bn] = await app.db.query('SELECT name FROM booths WHERE id = ? LIMIT 1', [boothId])
      const name = ((bn as { name: string }[])[0]?.name) ?? ''

      return sendOk(reply, {
        checkin_id: id,
        booth: { id: boothId, name },
        synced_at: `${synced.replace(' ', 'T')}Z`,
      })
    },
  )

  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/checkins',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub
      const [rows] = await app.db.query(
        `SELECT ci.id, ci.booth_id, b.name AS booth_name, ci.checkin_method, ci.checked_in_at, ci.synced_at
         FROM check_ins ci
         JOIN booths b ON b.id = ci.booth_id
         WHERE ci.user_id = ? AND ci.event_id = ?
         ORDER BY ci.checked_in_at DESC`,
        [uid, eventId],
      )
      const list = (rows as {
        id: string
        booth_id: string
        booth_name: string
        checkin_method: string
        checked_in_at: string
        synced_at: string | null
      }[]).map((r) => ({
        id: r.id,
        booth_id: r.booth_id,
        booth_name: r.booth_name,
        method: r.checkin_method,
        checked_in_at: `${String(r.checked_in_at).replace(' ', 'T')}Z`,
        synced_at: r.synced_at ? `${String(r.synced_at).replace(' ', 'T')}Z` : null,
      }))
      return sendOk(reply, { checkins: list })
    },
  )

  app.post<{ Params: { event_id: string; checkin_id: string } }>(
    '/events/:event_id/checkins/:checkin_id/rating',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = ratingBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const { event_id, checkin_id } = req.params
      const uid = req.jwtUser!.sub
      const [rows] = await app.db.query(
        `SELECT ci.booth_id FROM check_ins ci WHERE ci.id = ? AND ci.user_id = ? AND ci.event_id = ? LIMIT 1`,
        [checkin_id, uid, event_id],
      )
      const ci = (rows as { booth_id: string }[])[0]
      if (!ci) {
        return sendFail(reply, 404, 'NOT_FOUND', 'チェックインが見つかりません')
      }
      const rid = randomUUID()
      try {
        await app.db.execute(
          `INSERT INTO booth_ratings (id, user_id, booth_id, event_id, checkin_id, rating)
           VALUES (?,?,?,?,?,?)`,
          [rid, uid, ci.booth_id, event_id, checkin_id, parsed.data.rating],
        )
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === 'ER_DUP_ENTRY') {
          return sendFail(reply, 409, 'CONFLICT', 'このチェックインには既に評価があります')
        }
        throw e
      }
      return sendOk(reply, { rating_id: rid })
    },
  )

  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/recommendations',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub

      const [open] = await app.db.query(
        `SELECT id, algorithm, offered_booth_ids FROM recommendations
         WHERE user_id = ? AND event_id = ? AND selected_booth_id IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [uid, eventId],
      )
      const openRow = (open as { id: string; algorithm: string; offered_booth_ids: unknown }[])[0]

      let recId: string
      let algorithm: string
      let boothIds: string[]

      if (openRow) {
        recId = openRow.id
        algorithm = openRow.algorithm
        boothIds = parseJsonStringArray(openRow.offered_booth_ids)
      } else {
        const [cand] = await app.db.query(
          `SELECT b.id FROM booths b
           WHERE b.event_id = ?
             AND b.id NOT IN (SELECT booth_id FROM check_ins WHERE user_id = ? AND event_id = ?)
           ORDER BY RAND() LIMIT 3`,
          [eventId, uid, eventId],
        )
        boothIds = (cand as { id: string }[]).map((r) => r.id)
        if (boothIds.length < 3) {
          const [fill] = await app.db.query(
            `SELECT id FROM booths WHERE event_id = ? ORDER BY RAND() LIMIT 3`,
            [eventId],
          )
          const all = (fill as { id: string }[]).map((r) => r.id)
          boothIds = [...new Set([...boothIds, ...all])].slice(0, 3)
        }
        recId = randomUUID()
        algorithm = 'mab'
        await app.db.execute(
          `INSERT INTO recommendations (id, user_id, event_id, offered_booth_ids, selected_booth_id, rejected_booth_ids, algorithm)
           VALUES (?,?,?,?,?,?,?)`,
          [recId, uid, eventId, JSON.stringify(boothIds), null, null, algorithm],
        )
      }

      if (!boothIds.length) {
        return sendFail(reply, 404, 'NOT_FOUND', '推薦できるブースがありません')
      }

      const [brows] = await app.db.query(
        `SELECT id, name FROM booths WHERE id IN (${boothIds.map(() => '?').join(',')})`,
        boothIds,
      )
      const bmap = new Map((brows as { id: string; name: string }[]).map((b) => [b.id, b.name]))
      const reasons: Array<'recommend' | 'semi_recommend' | 'discovery'> = [
        'recommend',
        'semi_recommend',
        'discovery',
      ]
      const booths = boothIds.map((id, i) => ({
        id,
        name: bmap.get(id) ?? '',
        labels: [] as string[],
        reason: reasons[Math.min(i, 2)]!,
      }))

      return sendOk(reply, {
        recommendation_id: recId,
        algorithm,
        booths,
      })
    },
  )

  app.post<{ Params: { event_id: string; recommendation_id: string } }>(
    '/events/:event_id/recommendations/:recommendation_id/select',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = selectRecBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const { event_id, recommendation_id } = req.params
      const uid = req.jwtUser!.sub
      const [rows] = await app.db.query(
        `SELECT id FROM recommendations WHERE id = ? AND user_id = ? AND event_id = ? LIMIT 1`,
        [recommendation_id, uid, event_id],
      )
      if (!(rows as { id: string }[]).length) {
        return sendFail(reply, 404, 'NOT_FOUND', '推薦が見つかりません')
      }
      await app.db.execute(
        `UPDATE recommendations SET selected_booth_id = ? WHERE id = ?`,
        [parsed.data.selected_booth_id, recommendation_id],
      )
      return sendOk(reply, {})
    },
  )
}

function parseJsonStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v) as unknown
      return Array.isArray(p) ? p.map(String) : []
    } catch {
      return []
    }
  }
  return []
}
