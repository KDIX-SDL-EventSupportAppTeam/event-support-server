import type { FastifyInstance } from 'fastify'
import { sendOk } from '../../../lib/response.js'
import { requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { fetchAppAccessRow } from '../../../lib/app-access.js'

function toIso(v: string | null): string | null {
  if (v === null) return null
  return `${String(v).replace(' ', 'T')}Z`
}

/** 運営スタッフ（manager/viewer）向けの読み取り専用 GET。書き込みは organizer のみ。 */
export async function adminAppAccessRoutes(app: FastifyInstance) {
  const pre = [requireStaff, requireEventMatchesJwt]

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
      return sendOk(reply, {
        event_id: row.event_id,
        mode: row.mode,
        app_opens_at: toIso(row.app_opens_at),
        app_closes_at: toIso(row.app_closes_at),
        pre_survey_closes_at: toIso(row.pre_survey_closes_at),
        updated_by: row.updated_by,
        updated_at: toIso(row.updated_at),
      })
    },
  )
}
