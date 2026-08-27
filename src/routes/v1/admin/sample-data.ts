import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { clearSampleData } from '../../../lib/sample-data/clear.js'
import { SampleDataConflictError } from '../../../lib/sample-data/errors.js'
import { generateSampleData } from '../../../lib/sample-data/generate.js'
import { requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'

const generateBody = z.object({
  force: z.boolean().optional(),
})

export async function adminSampleDataRoutes(app: FastifyInstance) {
  const pre = [requireManager, requireEventMatchesJwt]

  app.post<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/sample-data/generate',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = generateBody.safeParse(req.body ?? {})
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      try {
        const result = await generateSampleData(app.db, req.params.event_id, {
          force: parsed.data.force,
        })
        return sendOk(reply, { generated: result })
      } catch (e) {
        if (e instanceof SampleDataConflictError) {
          return sendFail(reply, 409, 'CONFLICT', e.message)
        }
        const msg = e instanceof Error ? e.message : 'サンプルデータの生成に失敗しました'
        return sendFail(reply, 500, 'INTERNAL_ERROR', msg)
      }
    },
  )

  app.delete<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/sample-data',
    { preHandler: pre },
    async (req, reply) => {
      try {
        const result = await clearSampleData(app.db, req.params.event_id)
        // cleared の形は据え置き、割り当て解除したマス数は兄弟フィールドとして足す（追加のみ・破壊的変更なし）
        return sendOk(reply, { cleared: result.deleted, cleared_cells: result.cleared_cells })
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'サンプルデータの削除に失敗しました'
        return sendFail(reply, 500, 'INTERNAL_ERROR', msg)
      }
    },
  )
}
