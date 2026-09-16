import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireManager, requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'
import { generateUniqueManualCode } from '../../../lib/manual-code.js'
import { buildBoothCheckinUrl } from '../../../lib/url.js'

const boothBody = z.object({
  name: z.string().min(1).max(200),
  // 公開してよいブース番号（小間番号）。掲示・ポスター・参加者一覧で使う（issue #121）
  display_code: z.string().max(16).nullable().optional(),
  description: z.string().max(2000).optional(),
  category_id: z.string().uuid().nullable().optional(),
  // 手動コードはサーバーが自動採番する。運営の手入力は「刷り済みの紙に合わせる」逃げ道として
  // 残すが、受け付けるのは6桁数字のみ（issue #121）
  manual_code: z.string().regex(/^[0-9]{6}$/).optional(),
  tags: z.array(z.string().min(1).max(255)).optional(),
})

/** audit_logs の本文に手動コードの値を残さない（issue #121）。 */
function redactManualCode<T extends Record<string, unknown>>(detail: T): T {
  if (!('manual_code' in detail)) return detail
  return { ...detail, manual_code: '[REDACTED]' }
}

/** GET 一覧のソート指定（#55 §4-2）。zod 通過値のみを SORT_SQL のキーに使う。 */
export const boothListQuery = z.object({
  sort: z.enum(['checkin_count', 'avg_rating', 'name']).default('checkin_count'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

/** zod 通過値をキーに引く定数マップ（リクエスト文字列を直接 SQL に連結しない）。 */
export const SORT_SQL: Record<'checkin_count' | 'avg_rating' | 'name', (dir: 'ASC' | 'DESC') => string> = {
  checkin_count: (dir) => `checkin_count ${dir}`,
  avg_rating: (dir) => `(avg_rating IS NULL), avg_rating ${dir}`, // NULL は常に末尾
  name: (dir) => `b.name ${dir}`,
}
export const DIR_SQL = { asc: 'ASC', desc: 'DESC' } as const

async function replaceBoothTags(
  app: FastifyInstance,
  boothId: string,
  tags: string[] | undefined,
) {
  if (tags === undefined) return
  await app.db.execute('DELETE FROM booth_tags WHERE booth_id = ?', [boothId])
  for (const tag of tags) {
    await app.db.execute(
      'INSERT INTO booth_tags (id, booth_id, tag) VALUES (?,?,?)',
      [randomUUID(), boothId, tag],
    )
  }
}

export async function adminBoothRoutes(app: FastifyInstance) {
  const pre = [requireManager, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string }; Querystring: Record<string, string> }>(
    '/admin/events/:event_id/booths',
    { preHandler: [requireStaff, requireEventMatchesJwt] },
    async (req, reply) => {
      const parsed = boothListQuery.safeParse(req.query)
      const q = parsed.success ? parsed.data : { sort: 'checkin_count' as const, order: 'desc' as const }
      const orderBy = `${SORT_SQL[q.sort](DIR_SQL[q.order])}, b.name ASC`

      const [rows] = await app.db.query(
        `SELECT b.id, b.name, b.display_code, b.manual_code,
           (SELECT COUNT(*)           FROM check_ins ci     WHERE ci.booth_id = b.id) AS checkin_count,
           (SELECT AVG(br.rating)     FROM booth_ratings br  WHERE br.booth_id = b.id) AS avg_rating,
           (SELECT COUNT(br2.comment) FROM booth_ratings br2 WHERE br2.booth_id = b.id) AS comment_count
         FROM booths b
         WHERE b.event_id = ?
         ORDER BY ${orderBy}`,
        [req.params.event_id],
      )

      const booths = (rows as {
        id: string
        name: string
        display_code: string | null
        manual_code: string
        checkin_count: number
        avg_rating: number | null
        comment_count: number
      }[]).map((b) => ({
        id: b.id,
        name: b.name,
        display_code: b.display_code ?? null,
        // 秘匿コード。運営には掲示物作成のために返す（参加者向け API では返さない）
        manual_code: b.manual_code,
        checkin_url: buildBoothCheckinUrl(app.config, b.id),
        checkin_count: Number(b.checkin_count) || 0,
        avg_rating: b.avg_rating == null ? null : Math.round(Number(b.avg_rating) * 100) / 100,
        comment_count: Number(b.comment_count) || 0,
      }))

      return sendOk(reply, { booths })
    },
  )

  app.post<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/booths',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = boothBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data
      const id = randomUUID()
      // 手入力が無ければサーバーが6桁数字を採番する（issue #121）
      const manualCode =
        body.manual_code ?? (await generateUniqueManualCode(app.db, req.params.event_id))
      try {
        await app.db.execute(
          `INSERT INTO booths (id, event_id, name, display_code, description, category_id, manual_code)
           VALUES (?,?,?,?,?,?,?)`,
          [
            id,
            req.params.event_id,
            body.name,
            body.display_code ?? null,
            body.description ?? null,
            body.category_id ?? null,
            manualCode,
          ],
        )
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === 'ER_DUP_ENTRY') {
          return sendFail(reply, 409, 'CONFLICT', 'manual_code が既に使われています')
        }
        throw e
      }
      await replaceBoothTags(app, id, body.tags)
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'booth.create',
        targetType: 'booth',
        targetId: id,
        // 手動コードの値は本文に残さない（issue #121）
        detail: { name: body.name, manual_code_source: body.manual_code ? 'manual' : 'auto' },
      })
      return sendOk(
        reply,
        {
          booth: {
            id,
            name: body.name,
            display_code: body.display_code ?? null,
            description: body.description ?? '',
            category_id: body.category_id ?? null,
            manual_code: manualCode,
            checkin_url: buildBoothCheckinUrl(app.config, id),
            tags: body.tags ?? [],
          },
        },
        201,
      )
    },
  )

  app.patch<{ Params: { event_id: string; booth_id: string } }>(
    '/admin/events/:event_id/booths/:booth_id',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = boothBody.partial().safeParse(req.body)
      if (!parsed.success || !Object.keys(parsed.data).length) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data
      const fields: string[] = []
      const params: unknown[] = []

      if (body.name !== undefined) {
        fields.push('name = ?')
        params.push(body.name)
      }
      if (body.display_code !== undefined) {
        fields.push('display_code = ?')
        params.push(body.display_code)
      }
      if (body.description !== undefined) {
        fields.push('description = ?')
        params.push(body.description)
      }
      if (body.category_id !== undefined) {
        fields.push('category_id = ?')
        params.push(body.category_id)
      }
      if (body.manual_code !== undefined) {
        // zod で 6桁数字に検証済み（運営が刷り済みの紙に合わせる逃げ道）
        fields.push('manual_code = ?')
        params.push(body.manual_code)
      }

      const [existingRows] = await app.db.query(
        'SELECT id FROM booths WHERE id = ? AND event_id = ? LIMIT 1',
        [req.params.booth_id, req.params.event_id],
      )
      if (!(existingRows as { id: string }[])[0]) {
        return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
      }

      if (fields.length) {
        params.push(req.params.booth_id, req.params.event_id)
        try {
          await app.db.execute(
            `UPDATE booths SET ${fields.join(', ')} WHERE id = ? AND event_id = ?`,
            params,
          )
        } catch (e: unknown) {
          const err = e as { code?: string }
          if (err.code === 'ER_DUP_ENTRY') {
            return sendFail(reply, 409, 'CONFLICT', 'manual_code が既に使われています')
          }
          throw e
        }
      }

      await replaceBoothTags(app, req.params.booth_id, body.tags)
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'booth.update',
        targetType: 'booth',
        targetId: req.params.booth_id,
        detail: redactManualCode(body),
      })

      const [rows] = await app.db.query(
        `SELECT id, name, display_code, description, category_id, manual_code
         FROM booths WHERE id = ? AND event_id = ? LIMIT 1`,
        [req.params.booth_id, req.params.event_id],
      )
      const b = (rows as {
        id: string
        name: string
        display_code: string | null
        description: string | null
        category_id: string | null
        manual_code: string
      }[])[0]
      const [tags] = await app.db.query(
        'SELECT tag FROM booth_tags WHERE booth_id = ? ORDER BY tag ASC',
        [req.params.booth_id],
      )
      return sendOk(reply, {
        booth: {
          id: b.id,
          name: b.name,
          display_code: b.display_code ?? null,
          description: b.description ?? '',
          category_id: b.category_id,
          manual_code: b.manual_code,
          checkin_url: buildBoothCheckinUrl(app.config, b.id),
          tags: (tags as { tag: string }[]).map((t) => t.tag),
        },
      })
    },
  )

  app.delete<{ Params: { event_id: string; booth_id: string } }>(
    '/admin/events/:event_id/booths/:booth_id',
    { preHandler: pre },
    async (req, reply) => {
      const [result] = await app.db.execute(
        'DELETE FROM booths WHERE id = ? AND event_id = ?',
        [req.params.booth_id, req.params.event_id],
      )
      const affected = (result as { affectedRows?: number }).affectedRows ?? 0
      if (!affected) {
        return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
      }
      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'booth.delete',
        targetType: 'booth',
        targetId: req.params.booth_id,
      })
      return sendOk(reply, { deleted: true })
    },
  )

  // 手動コードの再発番（issue #121）。掲示物を刷り直す前提の操作なので manager 限定。
  // 監査ログには「再発番した」事実だけ残し、コードの値は残さない。
  app.post<{ Params: { event_id: string; booth_id: string } }>(
    '/admin/events/:event_id/booths/:booth_id/manual-code/regenerate',
    { preHandler: pre },
    async (req, reply) => {
      const [existingRows] = await app.db.query(
        'SELECT id FROM booths WHERE id = ? AND event_id = ? LIMIT 1',
        [req.params.booth_id, req.params.event_id],
      )
      if (!(existingRows as { id: string }[])[0]) {
        return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
      }

      const manualCode = await generateUniqueManualCode(app.db, req.params.event_id)
      try {
        await app.db.execute(
          'UPDATE booths SET manual_code = ? WHERE id = ? AND event_id = ?',
          [manualCode, req.params.booth_id, req.params.event_id],
        )
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === 'ER_DUP_ENTRY') {
          return sendFail(reply, 409, 'CONFLICT', 'manual_code が既に使われています')
        }
        throw e
      }

      await insertAuditLog(app.db, {
        eventId: req.params.event_id,
        actorId: req.jwtUser!.sub,
        actorRole: req.jwtUser!.role ?? 'manager',
        action: 'booth.manual_code.regenerate',
        targetType: 'booth',
        targetId: req.params.booth_id,
      })

      return sendOk(reply, {
        booth: {
          id: req.params.booth_id,
          manual_code: manualCode,
          checkin_url: buildBoothCheckinUrl(app.config, req.params.booth_id),
        },
      })
    },
  )
}
