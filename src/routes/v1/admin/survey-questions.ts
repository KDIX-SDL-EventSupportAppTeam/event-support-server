import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireStaff, requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'

const surveyBody = z.object({
  question_text: z.string().min(1).max(1000),
  options: z.array(z.string().min(1).max(200)).min(1),
  display_order: z.number().int().optional(),
  is_required: z.boolean().optional(),
})

function mapQuestion(row: {
  id: string
  question_text: string
  options: string | unknown
  display_order: number | null
  is_required: number | boolean | null
}) {
  const options =
    typeof row.options === 'string' ? (JSON.parse(row.options) as string[]) : (row.options as string[])
  return {
    id: row.id,
    question_text: row.question_text,
    options,
    display_order: row.display_order,
    is_required: Boolean(row.is_required),
  }
}

export async function adminSurveyQuestionRoutes(app: FastifyInstance) {
  const readPre = [requireStaff, requireEventMatchesJwt]
  const writePre = [requireManager, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/survey-questions',
    { preHandler: readPre },
    async (req, reply) => {
      const [rows] = await app.db.query(
        `SELECT id, question_text, options, display_order, is_required
         FROM survey_questions
         WHERE event_id = ?
         ORDER BY display_order ASC, question_text ASC`,
        [req.params.event_id],
      )
      return sendOk(reply, {
        questions: (rows as {
          id: string
          question_text: string
          options: string
          display_order: number | null
          is_required: number | boolean | null
        }[]).map(mapQuestion),
      })
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
      const id = randomUUID()
      await app.db.execute(
        `INSERT INTO survey_questions (id, event_id, question_text, options, display_order, is_required)
         VALUES (?,?,?,?,?,?)`,
        [
          id,
          req.params.event_id,
          body.question_text,
          JSON.stringify(body.options),
          body.display_order ?? null,
          body.is_required ?? false,
        ],
      )
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'survey_question.create',
        targetType: 'survey_question',
        targetId: id,
        detail: { question_text: body.question_text },
      })
      return sendOk(
        reply,
        {
          question: {
            id,
            question_text: body.question_text,
            options: body.options,
            display_order: body.display_order ?? null,
            is_required: body.is_required ?? false,
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
        params.push(JSON.stringify(body.options))
      }
      if (body.display_order !== undefined) {
        fields.push('display_order = ?')
        params.push(body.display_order)
      }
      if (body.is_required !== undefined) {
        fields.push('is_required = ?')
        params.push(body.is_required)
      }

      const [existingRows] = await app.db.query(
        'SELECT id FROM survey_questions WHERE id = ? AND event_id = ? LIMIT 1',
        [req.params.question_id, req.params.event_id],
      )
      if (!(existingRows as { id: string }[])[0]) {
        return sendFail(reply, 404, 'NOT_FOUND', '設問が見つかりません')
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
        `SELECT id, question_text, options, display_order, is_required
         FROM survey_questions WHERE id = ? AND event_id = ? LIMIT 1`,
        [req.params.question_id, req.params.event_id],
      )
      const q = (rows as {
        id: string
        question_text: string
        options: string
        display_order: number | null
        is_required: number | boolean | null
      }[])[0]
      return sendOk(reply, { question: mapQuestion(q) })
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
