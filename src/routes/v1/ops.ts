import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../lib/response.js'

const webhookBody = z.object({
  event_id: z.string().uuid(),
  google_form_response_id: z.string().min(1).max(500),
  booth: z.object({
    name: z.string().min(1).max(500),
    description: z.string().max(5000).optional(),
    category_name: z.string().max(200).optional(),
    tags: z.array(z.string().max(255)).max(50).optional(),
  }),
})

function randomManualCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)]!
  return s
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post('/webhook/booths/sync', async (req, reply) => {
    const key = req.headers['x-api-key']
    const expected = app.config.webhookApiKey
    if (!expected || key !== expected) {
      return sendFail(reply, 401, 'UNAUTHORIZED', 'APIキーが不正です')
    }
    const parsed = webhookBody.safeParse(req.body)
    if (!parsed.success) {
      return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
    }
    const { event_id, google_form_response_id, booth } = parsed.data

    const [ev] = await app.db.query('SELECT id FROM events WHERE id = ? LIMIT 1', [event_id])
    if (!(ev as { id: string }[]).length) {
      return sendFail(reply, 404, 'NOT_FOUND', 'イベントが見つかりません')
    }

    const [existing] = await app.db.query(
      'SELECT id FROM booths WHERE event_id = ? AND google_form_response_id = ? LIMIT 1',
      [event_id, google_form_response_id],
    )
    const existingId = (existing as { id: string }[])[0]?.id

    let categoryId: string | null = null
    if (booth.category_name?.trim()) {
      const name = booth.category_name.trim()
      const [c] = await app.db.query(
        'SELECT id FROM categories WHERE event_id = ? AND name = ? LIMIT 1',
        [event_id, name],
      )
      const found = (c as { id: string }[])[0]
      if (found) {
        categoryId = found.id
      } else {
        const cid = randomUUID()
        await app.db.execute(
          'INSERT INTO categories (id, event_id, name) VALUES (?,?,?)',
          [cid, event_id, name],
        )
        categoryId = cid
      }
    }

    if (existingId) {
      await app.db.execute(
        `UPDATE booths SET name = ?, description = ?, category_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [booth.name, booth.description ?? null, categoryId, existingId],
      )
      await app.db.execute('DELETE FROM booth_tags WHERE booth_id = ?', [existingId])
      if (booth.tags?.length) {
        for (const tag of booth.tags) {
          await app.db.execute(
            'INSERT INTO booth_tags (id, booth_id, tag) VALUES (?,?,?)',
            [randomUUID(), existingId, tag.slice(0, 255)],
          )
        }
      }
      return sendOk(reply, { booth_id: existingId, action: 'updated' as const })
    }

    let manual = randomManualCode()
    for (let attempt = 0; attempt < 20; attempt++) {
      const [dup] = await app.db.query(
        'SELECT id FROM booths WHERE event_id = ? AND manual_code = ? LIMIT 1',
        [event_id, manual],
      )
      if (!(dup as { id: string }[]).length) break
      manual = randomManualCode()
      if (attempt === 19) {
        return sendFail(reply, 500, 'INTERNAL_ERROR', '手動コードの生成に失敗しました')
      }
    }

    const boothId = randomUUID()
    const qrUrl = `https://example.invalid/qr/${boothId}`
    await app.db.execute(
      `INSERT INTO booths (id, event_id, name, description, category_id, manual_code, qr_code_url, google_form_response_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        boothId,
        event_id,
        booth.name,
        booth.description ?? null,
        categoryId,
        manual,
        qrUrl,
        google_form_response_id,
      ],
    )
    if (booth.tags?.length) {
      for (const tag of booth.tags) {
        await app.db.execute(
          'INSERT INTO booth_tags (id, booth_id, tag) VALUES (?,?,?)',
          [randomUUID(), boothId, tag.slice(0, 255)],
        )
      }
    }
    return sendOk(reply, { booth_id: boothId, action: 'created' as const })
  })
}
