import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
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

export async function surveyRoutes(app: FastifyInstance) {
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
}
