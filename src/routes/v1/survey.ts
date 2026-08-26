import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'
import { fetchAppAccessRow, resolveEffectiveAccess } from '../../lib/app-access.js'

type AnswerType = 'single' | 'multi' | 'text'

type Option = { value: string; label: string }

type QuestionRow = {
  id: string
  question_text: string
  options: unknown
  display_order: number | null
  is_required: number | boolean | null
  answer_type: AnswerType | null
  question_key: string | null
}

/** 旧データ（文字列だけの配列）を `{ value, label }` 形式へ正規化する（02-data-model.md）。 */
function normalizeOptions(raw: unknown): Option[] {
  let arr: unknown[] = []
  if (Array.isArray(raw)) arr = raw
  else if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw) as unknown
      if (Array.isArray(p)) arr = p
    } catch {
      arr = []
    }
  }
  return arr.map((o) => {
    if (o && typeof o === 'object' && 'value' in o) {
      const oo = o as { value: unknown; label?: unknown }
      const value = String(oo.value)
      const label = oo.label !== undefined ? String(oo.label) : value
      return { value, label }
    }
    const s = String(o)
    return { value: s, label: s }
  })
}

/**
 * 設問一覧を配信用の形へ整形する。`interest_categories` は `options` を DB から読まず、
 * `categories` テーブルから動的生成する（P-10）。
 */
async function loadQuestionsForDelivery(
  app: FastifyInstance,
  eventId: string,
): Promise<{
  id: string
  question_key: string | null
  label: string
  answer_type: AnswerType
  required: boolean
  options: Option[]
}[]> {
  const [rows] = await app.db.query(
    `SELECT id, question_text, options, display_order, is_required, answer_type, question_key
     FROM survey_questions WHERE event_id = ? ORDER BY display_order ASC, id ASC`,
    [eventId],
  )
  const questions = rows as QuestionRow[]

  let categoryOptions: Option[] | null = null
  const needsCategories = questions.some((q) => q.question_key === 'interest_categories')
  if (needsCategories) {
    const [catRows] = await app.db.query(
      'SELECT id, name FROM categories WHERE event_id = ? ORDER BY name ASC',
      [eventId],
    )
    categoryOptions = (catRows as { id: string; name: string }[]).map((c) => ({
      value: c.id,
      label: c.name,
    }))
  }

  return questions.map((q) => {
    const answerType: AnswerType = q.answer_type ?? 'single'
    const options =
      q.question_key === 'interest_categories' ? (categoryOptions ?? []) : normalizeOptions(q.options)
    return {
      id: q.id,
      question_key: q.question_key,
      label: q.question_text,
      answer_type: answerType,
      required: Boolean(q.is_required),
      options,
    }
  })
}

const surveyAnswersBody = z.object({
  age_range: z.string().optional(),
  occupation: z.string().optional(),
  industry: z.string().optional(),
  custom_answers: z.record(z.unknown()).optional(),
})

export async function surveyRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

  /** 事前アンケート設問。未ログインでも見せる（公開）。06-api.md */
  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/pre-survey/questions',
    async (req, reply) => {
      const eventId = req.params.event_id
      const [eventRows] = await app.db.query('SELECT id FROM events WHERE id = ? LIMIT 1', [eventId])
      if (!(eventRows as { id: string }[])[0]) {
        return sendFail(reply, 404, 'NOT_FOUND', 'イベントが見つかりません')
      }

      const accessRow = await fetchAppAccessRow(app.db, eventId)
      const effective = resolveEffectiveAccess(accessRow)
      const questions = await loadQuestionsForDelivery(app, eventId)

      return sendOk(reply, {
        is_pre_survey_open: effective.is_pre_survey_open,
        pre_survey_closes_at: effective.pre_survey_closes_at,
        questions,
      })
    },
  )

  /** 既存。認証必須の設問一覧（question_key / answer_type / 正規化済み options を返す）。 */
  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/survey/questions',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const questions = await loadQuestionsForDelivery(app, eventId)
      return sendOk(reply, { questions })
    },
  )

  app.post<{ Params: { event_id: string } }>(
    '/events/:event_id/survey/answers',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub

      const accessRow = await fetchAppAccessRow(app.db, eventId)
      const effective = resolveEffectiveAccess(accessRow)
      if (!effective.is_pre_survey_open) {
        return sendFail(reply, 409, 'PRE_SURVEY_CLOSED', '事前アンケートの回答受付は終了しました')
      }

      const parsed = surveyAnswersBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 400, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data
      const customAnswers = (body.custom_answers ?? {}) as Record<string, unknown>

      const questions = await loadQuestionsForDelivery(app, eventId)

      // 設問キーごとの値解決: age_range / occupation / industry は専用列と custom_answers 双方に併記する
      const valueByKey = new Map<string, unknown>()
      if (body.age_range !== undefined) valueByKey.set('age_range', body.age_range)
      if (body.occupation !== undefined) valueByKey.set('occupation', body.occupation)
      if (body.industry !== undefined) valueByKey.set('industry', body.industry)
      for (const [k, v] of Object.entries(customAnswers)) {
        valueByKey.set(k, v)
      }

      for (const q of questions) {
        if (!q.question_key) continue
        const val = valueByKey.get(q.question_key)

        if (q.required && (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0))) {
          return sendFail(reply, 400, 'VALIDATION_ERROR', `${q.question_key} は必須です`)
        }
        if (val === undefined || val === null) continue

        if (q.answer_type === 'single') {
          if (typeof val !== 'string') {
            return sendFail(reply, 400, 'VALIDATION_ERROR', `${q.question_key} の値が不正です`)
          }
          if (q.options.length && !q.options.some((o) => o.value === val)) {
            return sendFail(reply, 400, 'VALIDATION_ERROR', `${q.question_key} の選択肢が不正です`)
          }
        } else if (q.answer_type === 'multi') {
          if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
            return sendFail(reply, 400, 'VALIDATION_ERROR', `${q.question_key} の値が不正です`)
          }
          if (q.options.length) {
            const optionValues = new Set(q.options.map((o) => o.value))
            for (const v of val as string[]) {
              if (!optionValues.has(v)) {
                return sendFail(reply, 400, 'VALIDATION_ERROR', `${q.question_key} の選択肢が不正です`)
              }
            }
          }
        } else if (q.answer_type === 'text') {
          if (typeof val !== 'string') {
            return sendFail(reply, 400, 'VALIDATION_ERROR', `${q.question_key} の値が不正です`)
          }
        }
      }

      const ageRange = (valueByKey.get('age_range') as string | undefined) ?? null
      const occupation = (valueByKey.get('occupation') as string | undefined) ?? null
      const industry = (valueByKey.get('industry') as string | undefined) ?? null

      const [existingRows] = await app.db.query(
        'SELECT id FROM user_survey_answers WHERE user_id = ? AND event_id = ? LIMIT 1',
        [uid, eventId],
      )
      const existing = (existingRows as { id: string }[])[0]

      if (existing) {
        await app.db.execute(
          `UPDATE user_survey_answers
           SET age_range = ?, occupation = ?, industry = ?, custom_answers = ?
           WHERE id = ?`,
          [ageRange, occupation, industry, JSON.stringify(customAnswers), existing.id],
        )
      } else {
        const id = randomUUID()
        await app.db.execute(
          `INSERT INTO user_survey_answers (id, user_id, event_id, age_range, occupation, industry, custom_answers)
           VALUES (?,?,?,?,?,?,?)`,
          [id, uid, eventId, ageRange, occupation, industry, JSON.stringify(customAnswers)],
        )
      }

      return sendOk(reply, { answered_at: new Date().toISOString() })
    },
  )
}
