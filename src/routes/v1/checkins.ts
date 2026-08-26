import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isoToMysqlUtc, utcMysqlNow } from '../../lib/datetime.js'
import { sendFail, sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt, requireVerifiedEmail } from '../../plugins/auth.js'
import { ensureCard } from '../../lib/bingo/ensureCard.js'
import { processCenterAchievement, type UnlockedPair } from '../../lib/bingo/unlock.js'
import { checkCooldown } from '../../lib/bingo/cooldown.js'
import { countCompletedLines } from '../../lib/bingo/lines.js'

const checkinBody = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('qr'),
    booth_id: z.string().uuid(),
    checked_in_at: z.string(),
  }),
  z.object({
    method: z.literal('manual'),
    manual_code: z.string().min(1).max(6),
    checked_in_at: z.string(),
  }),
])

const ratingBody = z.object({
  rating: z.number().int().min(1),
  comment: z.string().max(500).optional(),
  context: z.enum(['NEXT_CHECKIN', 'MANUAL']).optional().default('MANUAL'),
})

/** そのユーザー・イベントで未評価の最新チェックインを返す（rating-collection.md）。自分自身は除く。 */
async function getPendingRating(
  app: FastifyInstance,
  eventId: string,
  uid: string,
  excludeCheckinId: string,
): Promise<{ checkin_id: string; booth_id: string; booth_name: string } | null> {
  const [rows] = await app.db.query(
    `SELECT ci.id, ci.booth_id, b.name AS booth_name
       FROM check_ins ci
       JOIN booths b ON b.id = ci.booth_id
       LEFT JOIN booth_ratings r ON r.checkin_id = ci.id
      WHERE ci.user_id = ? AND ci.event_id = ? AND ci.id <> ? AND r.id IS NULL
      ORDER BY ci.checked_in_at DESC
      LIMIT 1`,
    [uid, eventId, excludeCheckinId],
  )
  const row = (rows as { id: string; booth_id: string; booth_name: string }[])[0]
  if (!row) return null
  return { checkin_id: row.id, booth_id: row.booth_id, booth_name: row.booth_name }
}

async function getAchievedPositions(app: FastifyInstance, cardId: string): Promise<Set<number>> {
  const [rows] = await app.db.query(
    `SELECT position FROM bingo_cells WHERE card_id = ? AND is_achieved = 1`,
    [cardId],
  )
  return new Set((rows as { position: number }[]).map((r) => r.position))
}

export async function checkinRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

  app.post<{ Params: { event_id: string } }>(
    '/events/:event_id/checkins',
    { preHandler: [requireBearerAuth, requireEventMatchesJwt, requireVerifiedEmail] },
    async (req, reply) => {
      const parsed = checkinBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub
      const body = parsed.data
      let boothId: string
      let boothName: string
      let method: 'qr' | 'manual'
      let checkedMysql: string
      try {
        checkedMysql = isoToMysqlUtc(body.checked_in_at)
      } catch {
        return sendFail(reply, 422, 'VALIDATION_ERROR', 'checked_in_at が不正です')
      }

      if (body.method === 'qr') {
        method = 'qr'
        boothId = body.booth_id
        const [b] = await app.db.query(
          'SELECT id, name FROM booths WHERE id = ? AND event_id = ? AND is_active = 1 LIMIT 1',
          [boothId, eventId],
        )
        const row = (b as { id: string; name: string }[])[0]
        if (!row) {
          return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
        }
        boothName = row.name
      } else {
        method = 'manual'
        const code = body.manual_code.trim().toUpperCase()
        const [b] = await app.db.query(
          'SELECT id, name FROM booths WHERE event_id = ? AND UPPER(manual_code) = ? AND is_active = 1 LIMIT 1',
          [eventId, code],
        )
        const row = (b as { id: string; name: string }[])[0]
        if (!row) {
          return sendFail(reply, 404, 'NOT_FOUND', '手動コードに一致するブースがありません')
        }
        boothId = row.id
        boothName = row.name
      }

      // カードは get-or-create（無ければここで作る。事前アンケート未回答でも必ず成功する）
      const card = await ensureCard(app.db, eventId, uid)

      // さくらプロキシは重複キーエラーを 500 に潰してしまい ER_DUP_ENTRY を
      // 受け取れないため、INSERT 前に重複を明示的に確認する
      const [dupRows] = await app.db.query(
        'SELECT id FROM check_ins WHERE user_id = ? AND booth_id = ? LIMIT 1',
        [uid, boothId],
      )
      if ((dupRows as { id: string }[])[0]) {
        return sendFail(reply, 409, 'CONFLICT', 'このブースには既にチェックイン済みです')
      }

      // クールタイム判定（既定 CHECKIN_COOLDOWN_SEC=0 では判定自体をスキップする）
      const cooldown = await checkCooldown(app.db, app.config.checkinCooldownSec, uid, eventId)
      if (cooldown.blocked) {
        return sendFail(reply, 429, 'COOLDOWN', `クールタイム中です（残り${cooldown.remainingSec}秒）`)
      }

      const [voRows] = await app.db.query(
        'SELECT COALESCE(MAX(visit_order),0) AS m FROM check_ins WHERE user_id = ? AND event_id = ?',
        [uid, eventId],
      )
      const visitOrder = Number((voRows as { m: number }[])[0]?.m ?? 0) + 1

      const beforeAchieved = await getAchievedPositions(app, card.id)

      const id = randomUUID()
      const synced = utcMysqlNow()
      try {
        await app.db.execute(
          `INSERT INTO check_ins (id, user_id, booth_id, event_id, checkin_method, checked_in_at, synced_at, visit_order, cell_id)
           VALUES (?,?,?,?,?,?,?,?,NULL)`,
          [id, uid, boothId, eventId, method, checkedMysql, synced, visitOrder],
        )
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === 'ER_DUP_ENTRY') {
          return sendFail(reply, 409, 'CONFLICT', 'このブースには既にチェックイン済みです')
        }
        throw e
      }

      let filledCell: { position: number } | null = null
      let filledZone: 'CENTER' | 'OUTER' | null = null

      // 分岐1: そのブースが、既に見えている（is_revealed=1）未達成のマスに載っている
      // （事前推薦マス・解放済みの外周マスがこれに当たる）
      const [revealedRows] = await app.db.query(
        `SELECT id, position, zone FROM bingo_cells
         WHERE card_id = ? AND booth_id = ? AND is_revealed = 1 AND is_achieved = 0
         LIMIT 1`,
        [card.id, boothId],
      )
      const revealed = (revealedRows as { id: string; position: number; zone: 'CENTER' | 'OUTER' }[])[0]
      if (revealed) {
        const now = utcMysqlNow()
        const [result] = await app.db.execute(
          `UPDATE bingo_cells SET is_achieved = 1, achieved_at = ? WHERE id = ? AND is_achieved = 0`,
          [now, revealed.id],
        )
        const affected = (result as { affectedRows: number }).affectedRows
        if (affected === 1) {
          filledCell = { position: revealed.position }
          filledZone = revealed.zone
          await app.db.execute('UPDATE check_ins SET cell_id = ? WHERE id = ?', [revealed.id, id])
        }
      }

      // 分岐2: 中央マスに空きがある（後出し割当）
      if (!filledCell) {
        const [centerRows] = await app.db.query(
          `SELECT id, position FROM bingo_cells
           WHERE card_id = ? AND zone = 'CENTER' AND booth_id IS NULL
           ORDER BY position ASC LIMIT 1`,
          [card.id],
        )
        const centerCell = (centerRows as { id: string; position: number }[])[0]
        if (centerCell) {
          const now = utcMysqlNow()
          const [result] = await app.db.execute(
            `UPDATE bingo_cells
             SET booth_id = ?, is_revealed = 1, is_achieved = 1,
                 source = 'FREE_VISIT', assigned_at = ?, achieved_at = ?
             WHERE id = ? AND booth_id IS NULL`,
            [boothId, now, now, centerCell.id],
          )
          const affected = (result as { affectedRows: number }).affectedRows
          if (affected === 1) {
            filledCell = { position: centerCell.position }
            filledZone = 'CENTER'
            await app.db.execute('UPDATE check_ins SET cell_id = ? WHERE id = ?', [centerCell.id, id])
          }
        }
      }
      // 分岐3: どちらでもない（カード外訪問）。cell_id は NULL のまま。記録は必ず残す。

      let unlockedPositions: number[] = []
      // ペア単位の内訳。unlocked_positions は複数ペアが平坦に混ざるため、
      // フロントの解放演出（pair_key 単位の再生済みフラグ）にはこちらを使う
      let unlockedPairs: UnlockedPair[] = []
      if (filledZone === 'CENTER') {
        const result = await processCenterAchievement(app.db, app.config, eventId, uid, card.id)
        unlockedPositions = result.unlockedPositions
        unlockedPairs = result.unlockedPairs
        if (unlockedPositions.length) {
          app.io.to(`event:${eventId}:user:${uid}`).emit('bingo:unlocked', {
            unlock_event_ids: result.unlockEventIds,
            released_positions: unlockedPositions,
            unlocked_pairs: unlockedPairs,
            unlocked_at: `${synced.replace(' ', 'T')}Z`,
          })
        }
      }

      const afterAchieved = await getAchievedPositions(app, card.id)
      const linesCompleted = countCompletedLines(afterAchieved)
      const newLines = linesCompleted - countCompletedLines(beforeAchieved)

      const pendingRating = await getPendingRating(app, eventId, uid, id)

      app.io.to(`event:${eventId}:admin`).emit('checkin:new', {
        booth_id: boothId,
        booth_name: boothName,
        user_display_name: req.jwtUser!.display_name,
        checked_in_at: body.checked_in_at,
      })

      return sendOk(reply, {
        result: 'OK',
        checkin_id: id,
        booth: { id: boothId, name: boothName },
        synced_at: `${synced.replace(' ', 'T')}Z`,
        cooldown_remaining_sec: 0,
        filled_cell: filledCell,
        unlocked_positions: unlockedPositions,
        unlocked_pairs: unlockedPairs,
        new_lines: Math.max(newLines, 0),
        lines_completed: linesCompleted,
        pending_rating: pendingRating,
      })
    },
  )

  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/checkins',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub
      const [rows] = await app.db.query(
        `SELECT ci.id, ci.booth_id, b.name AS booth_name, ci.checkin_method, ci.checked_in_at, ci.synced_at
         FROM check_ins ci
         JOIN booths b ON b.id = ci.booth_id
         WHERE ci.user_id = ? AND ci.event_id = ?
         ORDER BY ci.checked_in_at DESC`,
        [uid, eventId],
      )
      const list = (rows as {
        id: string
        booth_id: string
        booth_name: string
        checkin_method: string
        checked_in_at: string
        synced_at: string | null
      }[]).map((r) => ({
        id: r.id,
        booth_id: r.booth_id,
        booth_name: r.booth_name,
        method: r.checkin_method,
        checked_in_at: `${String(r.checked_in_at).replace(' ', 'T')}Z`,
        synced_at: r.synced_at ? `${String(r.synced_at).replace(' ', 'T')}Z` : null,
      }))
      return sendOk(reply, { checkins: list })
    },
  )

  app.post<{ Params: { event_id: string; checkin_id: string } }>(
    '/events/:event_id/checkins/:checkin_id/rating',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = ratingBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const ratingScale = app.config.ratingScale
      if (parsed.data.rating > ratingScale) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', `評価は1〜${ratingScale}の範囲で入力してください`)
      }
      const { event_id, checkin_id } = req.params
      const uid = req.jwtUser!.sub
      const [rows] = await app.db.query(
        `SELECT ci.booth_id, b.name AS booth_name
         FROM check_ins ci
         JOIN booths b ON b.id = ci.booth_id
         WHERE ci.id = ? AND ci.user_id = ? AND ci.event_id = ? LIMIT 1`,
        [checkin_id, uid, event_id],
      )
      const ci = (rows as { booth_id: string; booth_name: string }[])[0]
      if (!ci) {
        return sendFail(reply, 404, 'NOT_FOUND', 'チェックインが見つかりません')
      }

      // さくらプロキシは重複キーを 500 に潰すため、INSERT 前に重複評価を確認する
      const [dupRating] = await app.db.query(
        'SELECT id FROM booth_ratings WHERE checkin_id = ? LIMIT 1',
        [checkin_id],
      )
      if ((dupRating as { id: string }[])[0]) {
        return sendFail(reply, 409, 'CONFLICT', 'このチェックインには既に評価があります')
      }

      const comment = parsed.data.comment?.trim() || null // 空文字・空白のみ → null（COUNT(comment)/IS NOT NULL の判定を単純にする）

      const rid = randomUUID()
      try {
        await app.db.execute(
          `INSERT INTO booth_ratings (id, user_id, booth_id, event_id, checkin_id, rating, comment, prompt_context, scale)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [rid, uid, ci.booth_id, event_id, checkin_id, parsed.data.rating, comment, parsed.data.context, ratingScale],
        )
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === 'ER_DUP_ENTRY') {
          return sendFail(reply, 409, 'CONFLICT', 'このチェックインには既に評価があります')
        }
        throw e
      }

      app.io.to(`event:${event_id}:admin`).emit('rating:new', {
        booth_id: ci.booth_id,
        booth_name: ci.booth_name,
        rating: parsed.data.rating,
        comment,
        user_display_name: req.jwtUser!.display_name,
      })

      return sendOk(reply, { rating_id: rid })
    },
  )
}
