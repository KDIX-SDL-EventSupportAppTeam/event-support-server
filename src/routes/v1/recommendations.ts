import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'

const selectRecBody = z.object({ selected_booth_id: z.string().uuid() })

export async function recommendationRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

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
        const external = await fetchExternalRecommendations(app, eventId, uid)
        if (external) {
          boothIds = external.boothIds
          algorithm = external.algorithm
        } else {
          const fallback = await pickFallbackBoothIds(app, eventId, uid)
          boothIds = fallback.boothIds
          algorithm = fallback.algorithm
        }
        recId = randomUUID()
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
        `SELECT id, offered_booth_ids FROM recommendations WHERE id = ? AND user_id = ? AND event_id = ? LIMIT 1`,
        [recommendation_id, uid, event_id],
      )
      const rec = (rows as { id: string; offered_booth_ids: unknown }[])[0]
      if (!rec) {
        return sendFail(reply, 404, 'NOT_FOUND', '推薦が見つかりません')
      }
      const offeredBoothIds = parseJsonStringArray(rec.offered_booth_ids)
      if (!offeredBoothIds.includes(parsed.data.selected_booth_id)) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '提示された推薦に含まれないブースです')
      }
      await app.db.execute(
        `UPDATE recommendations SET selected_booth_id = ? WHERE id = ?`,
        [parsed.data.selected_booth_id, recommendation_id],
      )
      return sendOk(reply, {})
    },
  )
}

async function pickFallbackBoothIds(
  app: FastifyInstance,
  eventId: string,
  uid: string,
): Promise<{ boothIds: string[]; algorithm: string }> {
  const [cand] = await app.db.query(
    `SELECT b.id FROM booths b
     WHERE b.event_id = ?
       AND b.id NOT IN (SELECT booth_id FROM check_ins WHERE user_id = ? AND event_id = ?)
     ORDER BY RAND() LIMIT 3`,
    [eventId, uid, eventId],
  )
  let boothIds = (cand as { id: string }[]).map((r) => r.id)
  if (boothIds.length < 3) {
    const [fill] = await app.db.query(`SELECT id FROM booths WHERE event_id = ? ORDER BY RAND() LIMIT 3`, [
      eventId,
    ])
    const all = (fill as { id: string }[]).map((r) => r.id)
    boothIds = [...new Set([...boothIds, ...all])].slice(0, 3)
  }
  return { boothIds, algorithm: 'mab' }
}

async function fetchExternalRecommendations(
  app: FastifyInstance,
  eventId: string,
  uid: string,
): Promise<{ boothIds: string[]; algorithm: string } | null> {
  const baseUrl = app.config.recommenderUrl.trim()
  if (!baseUrl) return null
  const url = `${baseUrl.replace(/\/+$/, '')}/recommendations`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event_id: eventId,
        user_id: uid,
        limit: 3,
      }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    const parsed = parseExternalRecommendationResponse(body)
    if (!parsed.boothIds.length) return null
    return parsed
  } catch {
    return null
  }
}

function parseExternalRecommendationResponse(v: unknown): { boothIds: string[]; algorithm: string } {
  const body = asObject(v)
  const directIds = parseJsonStringArray(body?.booth_ids)
  const data = asObject(body?.data)
  const dataIds = parseJsonStringArray(data?.booth_ids)
  const offeredIds = parseJsonStringArray(data?.offered_booth_ids)
  const boothIds = [...new Set([...directIds, ...dataIds, ...offeredIds])].slice(0, 3)

  const directAlgo = typeof body?.algorithm === 'string' ? body.algorithm : ''
  const dataAlgo = typeof data?.algorithm === 'string' ? data.algorithm : ''
  const algorithm = (directAlgo || dataAlgo || 'mab').slice(0, 50)

  return { boothIds, algorithm }
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
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
