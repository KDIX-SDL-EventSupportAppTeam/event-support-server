import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'
import { fetchAwardSettings } from '../../lib/award/settings.js'

/**
 * 参加者向けアワード投票 API（issue #124）。
 *
 * 投票できるのは、その参加者がチェックイン済みのブースだけ。
 * **「チェックイン済み」の照合はサーバーで行う**（UI の選択肢制限は関門ではない）。
 *
 * 仕様: docs/specs/gacha-and-award/06-api/award-api.md
 */

type BoothRow = {
  id: string
  name: string
  description: string | null
  display_code: string | null
  category_id: string | null
}

/** GET /v1/booths の1行と同じ形（frontend の mapV1Booth をそのまま使えるようにする）。manual_code は含めない。 */
function toBoothShape(b: BoothRow) {
  return {
    id: b.id,
    name: b.name,
    description: b.description ?? '',
    display_code: b.display_code ?? null,
    category_id: b.category_id ?? null,
  }
}

async function loadAwards(app: FastifyInstance, eventId: string) {
  const [rows] = await app.db.query(
    `SELECT id, name, description, color
       FROM awards
      WHERE event_id = ?
      ORDER BY sort_order ASC, name ASC`,
    [eventId],
  )
  return (rows as { id: string; name: string; description: string | null; color: string }[]).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description ?? '',
    color: a.color,
  }))
}

async function loadCheckedBooths(app: FastifyInstance, eventId: string, uid: string): Promise<BoothRow[]> {
  const [rows] = await app.db.query(
    `SELECT b.id, b.name, b.description, b.display_code, b.category_id
       FROM check_ins ci
       JOIN booths b ON b.id = ci.booth_id
      WHERE ci.user_id = ? AND ci.event_id = ? AND b.is_active = 1
      ORDER BY b.name ASC`,
    [uid, eventId],
  )
  return rows as BoothRow[]
}

async function loadVotes(app: FastifyInstance, eventId: string, uid: string): Promise<Record<string, string>> {
  const [rows] = await app.db.query(
    'SELECT award_id, booth_id FROM award_votes WHERE event_id = ? AND user_id = ?',
    [eventId, uid],
  )
  const out: Record<string, string> = {}
  for (const r of rows as { award_id: string; booth_id: string }[]) out[r.award_id] = r.booth_id
  return out
}

async function buildSnapshot(app: FastifyInstance, eventId: string, uid: string) {
  const [settings, awards, checkedBooths, votes] = await Promise.all([
    fetchAwardSettings(app.db, eventId),
    loadAwards(app, eventId),
    loadCheckedBooths(app, eventId, uid),
    loadVotes(app, eventId, uid),
  ])
  return {
    voting_open: settings.isOpen,
    awards,
    checked_booths: checkedBooths.map(toBoothShape),
    votes,
  }
}

const voteBody = z.object({
  votes: z.record(z.string().uuid(), z.string().uuid().nullable()),
})

export async function awardRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/awards/vote',
    { preHandler: pre },
    async (req, reply) => {
      const snapshot = await buildSnapshot(app, req.params.event_id, req.jwtUser!.sub)
      return sendOk(reply, snapshot)
    },
  )

  app.post<{ Params: { event_id: string } }>(
    '/events/:event_id/awards/vote',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub

      const parsed = voteBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const entries = Object.entries(parsed.data.votes)

      const settings = await fetchAwardSettings(app.db, eventId)
      if (!settings.isOpen) {
        return sendFail(reply, 409, 'VOTING_CLOSED', 'アワード投票は現在受け付けていません')
      }

      // 検証は全件まとめて行い、1件でも不正なら何も保存しない（部分適用しない）
      const [awardRows] = await app.db.query(
        'SELECT id FROM awards WHERE event_id = ?',
        [eventId],
      )
      const validAwards = new Set((awardRows as { id: string }[]).map((a) => a.id))

      const checked = await loadCheckedBooths(app, eventId, uid)
      const checkedIds = new Set(checked.map((b) => b.id))

      for (const [awardId, boothId] of entries) {
        if (!validAwards.has(awardId)) {
          return sendFail(reply, 404, 'NOT_FOUND', `賞が見つかりません（award_id=${awardId}）`)
        }
        if (boothId !== null && !checkedIds.has(boothId)) {
          return sendFail(
            reply,
            403,
            'NOT_CHECKED_IN',
            `チェックインしていない（または停止中の）ブースには投票できません（award_id=${awardId}）`,
          )
        }
      }

      // 適用。null は取り消し、それ以外は上書き（uq_vote_award_user で1参加者×1賞=1票）
      for (const [awardId, boothId] of entries) {
        if (boothId === null) {
          await app.db.execute(
            'DELETE FROM award_votes WHERE event_id = ? AND award_id = ? AND user_id = ?',
            [eventId, awardId, uid],
          )
        } else {
          await app.db.execute(
            `INSERT INTO award_votes (id, event_id, award_id, user_id, booth_id)
             VALUES (?,?,?,?,?)
             ON DUPLICATE KEY UPDATE booth_id = VALUES(booth_id), event_id = VALUES(event_id)`,
            [randomUUID(), eventId, awardId, uid, boothId],
          )
        }
      }

      const snapshot = await buildSnapshot(app, eventId, uid)
      return sendOk(reply, snapshot)
    },
  )
}
