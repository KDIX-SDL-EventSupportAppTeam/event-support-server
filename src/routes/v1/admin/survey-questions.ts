import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireStaff, requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'
import {
  ANSWER_TYPES,
  normalizeOptions,
  type AnswerType,
  type Option,
} from '../../../lib/survey-options.js'

/**
 * 選択肢は新形式 `{ value, label }` を正とし、旧形式の `string[]` も受け付ける。
 * 既存の運営画面が `string[]` を送り続けても壊れないようにするため（後方互換）。
 */
const optionInput = z.union([
  z.string().min(1).max(200),
  z.object({
    value: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
  }),
])

const surveyBody = z.object({
  question_text: z.string().min(1).max(1000),
  options: z.array(optionInput).min(1),
  display_order: z.number().int().optional(),
  is_required: z.boolean().optional(),
  question_key: z.string().min(1).max(50).optional(),
  answer_type: z.enum(ANSWER_TYPES).optional(),
})

/** 入力の選択肢を保存形式（`{ value, label }`）へ揃える。 */
function toStoredOptions(options: z.infer<typeof optionInput>[]): Option[] {
  return options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
}

type QuestionRow = {
  id: string
  question_text: string
  options: string | unknown
  display_order: number | null
  is_required: number | boolean | null
  question_key: string | null
  answer_type: string | null
}

const QUESTION_COLUMNS =
  'id, question_text, options, display_order, is_required, question_key, answer_type'

function mapQuestion(row: QuestionRow) {
  return {
    id: row.id,
    question_text: row.question_text,
    // 配信経路（routes/v1/survey.ts）と同じ正規化を通す。旧形式もここで {value,label} になる。
    options: normalizeOptions(row.options),
    display_order: row.display_order,
    is_required: Boolean(row.is_required),
    question_key: row.question_key ?? null,
    answer_type: (row.answer_type ?? 'single') as AnswerType,
  }
}

/**
 * 同一イベント内で `question_key` が重複しないことを確認する。
 * `question_key` は分析側が設問を特定する識別子なので、重複すると回答が読めなくなる。
 * NULL（キー無し）は重複可。プロキシがエラーを 500 に潰すため、DB の一意制約ではなく
 * INSERT 前の SELECT で確認する（ADR 0001）。
 */
async function isQuestionKeyTaken(
  app: FastifyInstance,
  eventId: string,
  questionKey: string,
  excludeQuestionId?: string,
): Promise<boolean> {
  const [rows] = await app.db.query(
    `SELECT id FROM survey_questions
     WHERE event_id = ? AND question_key = ? AND id <> ? LIMIT 1`,
    [eventId, questionKey, excludeQuestionId ?? ''],
  )
  return Boolean((rows as { id: string }[])[0])
}

export async function adminSurveyQuestionRoutes(app: FastifyInstance) {
  const readPre = [requireStaff, requireEventMatchesJwt]
  const writePre = [requireManager, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/survey-questions',
    { preHandler: readPre },
    async (req, reply) => {
      const [rows] = await app.db.query(
        `SELECT ${QUESTION_COLUMNS}
         FROM survey_questions
         WHERE event_id = ?
         ORDER BY display_order ASC, question_text ASC`,
        [req.params.event_id],
      )
      return sendOk(reply, { questions: (rows as QuestionRow[]).map(mapQuestion) })
    },
  )

  app.post<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/survey-questions',
    { preHandler: writePre },
    async (req, reply) => {
      const parsed = surveyBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data
      if (body.question_key && (await isQuestionKeyTaken(app, req.params.event_id, body.question_key))) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', 'question_key が既に使われています')
      }
      const options = toStoredOptions(body.options)
      const answerType: AnswerType = body.answer_type ?? 'single'
      const id = randomUUID()
      await app.db.execute(
        `INSERT INTO survey_questions
           (id, event_id, question_text, options, display_order, is_required, question_key, answer_type)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          id,
          req.params.event_id,
          body.question_text,
          JSON.stringify(options),
          body.display_order ?? null,
          body.is_required ?? false,
          body.question_key ?? null,
          answerType,
        ],
      )
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'survey_question.create',
        targetType: 'survey_question',
        targetId: id,
        detail: { question_text: body.question_text, question_key: body.question_key ?? null },
      })
      return sendOk(
        reply,
        {
          question: {
            id,
            question_text: body.question_text,
            options,
            display_order: body.display_order ?? null,
            is_required: body.is_required ?? false,
            question_key: body.question_key ?? null,
            answer_type: answerType,
          },
        },
        201,
      )
    },
  )

  app.patch<{ Params: { event_id: string; question_id: string } }>(
    '/admin/events/:event_id/survey-questions/:question_id',
    { preHandler: writePre },
    async (req, reply) => {
      const parsed = surveyBody.partial().safeParse(req.body)
      if (!parsed.success || !Object.keys(parsed.data).length) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data
      const fields: string[] = []
      const params: unknown[] = []

      if (body.question_text !== undefined) {
        fields.push('question_text = ?')
        params.push(body.question_text)
      }
      if (body.options !== undefined) {
        fields.push('options = ?')
        params.push(JSON.stringify(toStoredOptions(body.options)))
      }
      if (body.display_order !== undefined) {
        fields.push('display_order = ?')
        params.push(body.display_order)
      }
      if (body.is_required !== undefined) {
        fields.push('is_required = ?')
        params.push(body.is_required)
      }
      if (body.question_key !== undefined) {
        fields.push('question_key = ?')
        params.push(body.question_key)
      }
      if (body.answer_type !== undefined) {
        fields.push('answer_type = ?')
        params.push(body.answer_type)
      }

      const [existingRows] = await app.db.query(
        'SELECT id FROM survey_questions WHERE id = ? AND event_id = ? LIMIT 1',
        [req.params.question_id, req.params.event_id],
      )
      if (!(existingRows as { id: string }[])[0]) {
        return sendFail(reply, 404, 'NOT_FOUND', '設問が見つかりません')
      }
      if (
        body.question_key &&
        (await isQuestionKeyTaken(app, req.params.event_id, body.question_key, req.params.question_id))
      ) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', 'question_key が既に使われています')
      }

      params.push(req.params.question_id, req.params.event_id)
      await app.db.execute(
        `UPDATE survey_questions SET ${fields.join(', ')} WHERE id = ? AND event_id = ?`,
        params,
      )

      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'survey_question.update',
        targetType: 'survey_question',
        targetId: req.params.question_id,
        detail: body,
      })

      const [rows] = await app.db.query(
        `SELECT ${QUESTION_COLUMNS}
         FROM survey_questions WHERE id = ? AND event_id = ? LIMIT 1`,
        [req.params.question_id, req.params.event_id],
      )
      return sendOk(reply, { question: mapQuestion((rows as QuestionRow[])[0]) })
    },
  )

  app.delete<{ Params: { event_id: string; question_id: string } }>(
    '/admin/events/:event_id/survey-questions/:question_id',
    { preHandler: writePre },
    async (req, reply) => {
      const [result] = await app.db.execute(
        'DELETE FROM survey_questions WHERE id = ? AND event_id = ?',
        [req.params.question_id, req.params.event_id],
      )
      const affected = (result as { affectedRows?: number }).affectedRows ?? 0
      if (!affected) {
        return sendFail(reply, 404, 'NOT_FOUND', '設問が見つかりません')
      }
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'survey_question.delete',
        targetType: 'survey_question',
        targetId: req.params.question_id,
      })
      return sendOk(reply, { deleted: true })
    },
  )
}
