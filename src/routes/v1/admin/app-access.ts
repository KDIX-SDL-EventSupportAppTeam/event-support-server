import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireManager, requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'
import { fetchAppAccessRow, type AppAccessRow } from '../../../lib/app-access.js'

/**
 * manager が開催直前に切り替える開放スイッチ。`open` / `closed` のみ受け付ける。
 * 時刻指定（`scheduled`）は organizer 側（`PUT /organizer/events/:id/app-access`）に残す。
 */
const putBody = z.object({
  mode: z.enum(['open', 'closed']),
})

function toIso(v: string | null): string | null {
  if (v === null) return null
  return `${String(v).replace(' ', 'T')}Z`
}

function toResponse(row: AppAccessRow) {
  return {
    event_id: row.event_id,
    mode: row.mode,
    app_opens_at: toIso(row.app_opens_at),
    app_closes_at: toIso(row.app_closes_at),
    pre_survey_closes_at: toIso(row.pre_survey_closes_at),
    updated_by: row.updated_by,
    updated_at: toIso(row.updated_at),
  }
}

/** 運営スタッフ向け。GET は manager/viewer、開放スイッチ（PUT）は manager のみ。 */
export async function adminAppAccessRoutes(app: FastifyInstance) {
  const pre = [requireStaff, requireEventMatchesJwt]
  const manager = [requireManager, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/app-access',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const row = await fetchAppAccessRow(app.db, eventId)
      if (!row) {
        return sendOk(reply, {
          event_id: eventId,
          mode: 'closed',
          app_opens_at: null,
          app_closes_at: null,
          pre_survey_closes_at: null,
          updated_by: null,
          updated_at: null,
        })
      }
      return sendOk(reply, toResponse(row))
    },
  )

  app.put<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/app-access',
    { preHandler: manager },
    async (req, reply) => {
      const eventId = req.params.event_id
      const parsed = putBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }

      const existing = await fetchAppAccessRow(app.db, eventId)
      const before = existing ? toResponse(existing) : null

      // mode 以外（開放予定時刻など）は既存値を保つ。
      // `updated_by` は organizers(id) への外部キーのため、manager（users の行）の ID は入れられない。
      // 書き換えずに既存値を保ち、誰が切り替えたかは監査ログ（actor_id）に残す。
      await app.db.execute(
        `INSERT INTO event_app_access (event_id, mode, app_opens_at, app_closes_at, pre_survey_closes_at, updated_by)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           mode = VALUES(mode)`,
        [
          eventId,
          parsed.data.mode,
          existing?.app_opens_at ?? null,
          existing?.app_closes_at ?? null,
          existing?.pre_survey_closes_at ?? null,
          existing?.updated_by ?? null,
        ],
      )

      const updated = await fetchAppAccessRow(app.db, eventId)
      await insertAuditLog(app.db, {
        eventId,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'update',
        targetType: 'app_access',
        targetId: eventId,
        detail: { before, after: updated ? toResponse(updated) : null },
      })

      return sendOk(reply, updated ? toResponse(updated) : null)
    },
  )
}
