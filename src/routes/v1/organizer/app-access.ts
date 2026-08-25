import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireOrganizer } from '../../../plugins/auth.js'
import { assertEventOwnedByOrganizer } from '../../../lib/organizer.js'
import { insertAuditLog } from '../../../lib/audit.js'
import { isoToMysqlUtc } from '../../../lib/datetime.js'
import { fetchAppAccessRow, type AppAccessMode } from '../../../lib/app-access.js'

const putBody = z.object({
  mode: z.enum(['closed', 'scheduled', 'open']),
  app_opens_at: z.string().nullable().optional(),
  app_closes_at: z.string().nullable().optional(),
  pre_survey_closes_at: z.string().nullable().optional(),
})

function toIso(v: string | null): string | null {
  if (v === null) return null
  return `${String(v).replace(' ', 'T')}Z`
}

function toResponse(row: {
  event_id: string
  mode: AppAccessMode
  app_opens_at: string | null
  app_closes_at: string | null
  pre_survey_closes_at: string | null
  updated_by: string | null
  updated_at: string
}) {
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

export async function organizerAppAccessRoutes(app: FastifyInstance) {
  const pre = [requireOrganizer]

  app.get<{ Params: { event_id: string } }>(
    '/organizer/events/:event_id/app-access',
    { preHandler: pre },
    async (req, reply) => {
      const organizerId = req.organizerUser!.sub
      const eventId = req.params.event_id
      const owned = await assertEventOwnedByOrganizer(app.db, eventId, organizerId)
      if (!owned) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このイベントへのアクセス権限がありません')
      }

      const row = await fetchAppAccessRow(app.db, eventId)
      if (!row) {
        // 行が無いイベントは closed 相当（レスポンスとしては最小限の形で返す）
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
    '/organizer/events/:event_id/app-access',
    { preHandler: pre },
    async (req, reply) => {
      const organizerId = req.organizerUser!.sub
      const eventId = req.params.event_id
      const owned = await assertEventOwnedByOrganizer(app.db, eventId, organizerId)
      if (!owned) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このイベントへのアクセス権限がありません')
      }

      const parsed = putBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 400, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data

      if (body.mode === 'scheduled' && !body.app_opens_at) {
        return sendFail(reply, 400, 'VALIDATION_ERROR', 'app_opens_at は必須です')
      }

      const existing = await fetchAppAccessRow(app.db, eventId)

      // app_opens_at: mode が open/closed でも保持する（未指定なら既存値を維持）
      let appOpensAtMysql: string | null
      if (body.app_opens_at !== undefined) {
        appOpensAtMysql = body.app_opens_at === null ? null : isoToMysqlUtc(body.app_opens_at)
      } else {
        appOpensAtMysql = existing?.app_opens_at ?? null
      }

      let appClosesAtMysql: string | null
      if (body.app_closes_at !== undefined) {
        appClosesAtMysql = body.app_closes_at === null ? null : isoToMysqlUtc(body.app_closes_at)
      } else {
        appClosesAtMysql = existing?.app_closes_at ?? null
      }

      if (appClosesAtMysql !== null) {
        if (appOpensAtMysql === null || new Date(`${appClosesAtMysql.replace(' ', 'T')}Z`).getTime() <= new Date(`${appOpensAtMysql.replace(' ', 'T')}Z`).getTime()) {
          return sendFail(reply, 400, 'VALIDATION_ERROR', 'app_closes_at は app_opens_at より後である必要があります')
        }
      }

      let preSurveyClosesAtMysql: string | null
      if (body.pre_survey_closes_at !== undefined) {
        preSurveyClosesAtMysql = body.pre_survey_closes_at === null ? null : isoToMysqlUtc(body.pre_survey_closes_at)
      } else {
        preSurveyClosesAtMysql = existing?.pre_survey_closes_at ?? null
      }

      const before = existing ? toResponse(existing) : null

      await app.db.execute(
        `INSERT INTO event_app_access (event_id, mode, app_opens_at, app_closes_at, pre_survey_closes_at, updated_by)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           mode = VALUES(mode),
           app_opens_at = VALUES(app_opens_at),
           app_closes_at = VALUES(app_closes_at),
           pre_survey_closes_at = VALUES(pre_survey_closes_at),
           updated_by = VALUES(updated_by)`,
        [eventId, body.mode, appOpensAtMysql, appClosesAtMysql, preSurveyClosesAtMysql, organizerId],
      )

      const updated = await fetchAppAccessRow(app.db, eventId)

      await insertAuditLog(app.db, {
        eventId,
        actorId: organizerId,
        actorRole: 'organizer',
        action: 'update',
        targetType: 'app_access',
        targetId: eventId,
        detail: { before, after: updated ? toResponse(updated) : null },
      })

      return sendOk(reply, updated ? toResponse(updated) : null)
    },
  )
}
