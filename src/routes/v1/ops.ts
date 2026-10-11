import type { FastifyInstance } from 'fastify'
import { generateUniqueQrToken } from '../../lib/qr-token.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../lib/response.js'
import { safeCompare } from '../../lib/safe-compare.js'
import { generateManualCode } from '../../lib/manual-code.js'

/**
 * trim → 空文字除外 → 重複除去。booth_tags は (booth_id, tag) が一意で、照合順序が大文字小文字を
 * 区別しない（utf8mb4_unicode_ci）ため、"AI" と "ai" も同じタグとして扱い、最初の表記を残す。
 */
function normalizeTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags ?? []) {
    const tag = raw.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/**
 * タグを置き換える。先に新タグを入れてから、新タグに無いものだけを消す。
 * 本番はトランザクションが無い（1リクエスト=1SQL）ため、途中で失敗しても古いタグが残る順序にする。
 * INSERT は ON DUPLICATE KEY UPDATE で、既存タグ・照合順序上の同一タグでも例外にしない（ADR 0001）。
 */
async function replaceBoothTags(app: FastifyInstance, boothId: string, tags: string[]): Promise<void> {
  if (tags.length) {
    await app.db.execute(
      `INSERT INTO booth_tags (id, booth_id, tag) VALUES ${tags.map(() => '(?,?,?)').join(',')}
       ON DUPLICATE KEY UPDATE tag = tag`,
      tags.flatMap((tag) => [randomUUID(), boothId, tag]),
    )
    await app.db.execute(
      `DELETE FROM booth_tags WHERE booth_id = ? AND tag NOT IN (${tags.map(() => '?').join(',')})`,
      [boothId, ...tags],
    )
  } else {
    await app.db.execute('DELETE FROM booth_tags WHERE booth_id = ?', [boothId])
  }
}

const webhookBody = z.object({
  event_id: z.string().uuid(),
  google_form_response_id: z.string().min(1).max(500),
  booth: z.object({
    name: z.string().min(1).max(500),
    description: z.string().max(5000).optional(),
    category_name: z.string().max(200).optional(),
    tags: z.array(z.string().max(255)).max(50).optional().transform(normalizeTags),
  }),
})

// 手動コードは6桁数字・暗号論的乱数（issue #121。lib/manual-code.ts に統一）
const randomManualCode = generateManualCode

export async function webhookRoutes(app: FastifyInstance) {
  app.post('/webhook/booths/sync', async (req, reply) => {
    const key = req.headers['x-api-key']
    const expected = app.config.webhookApiKey
    if (!expected || !safeCompare(key, expected)) {
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
      // tags 省略時は従来どおり全削除（空配列と同じ）
      await replaceBoothTags(app, existingId, booth.tags)
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
      `INSERT INTO booths (id, event_id, name, description, category_id, manual_code, qr_token, qr_code_url, google_form_response_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        boothId,
        event_id,
        booth.name,
        booth.description ?? null,
        categoryId,
        manual,
        await generateUniqueQrToken(app.db),
        qrUrl,
        google_form_response_id,
      ],
    )
    if (booth.tags.length) await replaceBoothTags(app, boothId, booth.tags)
    return sendOk(reply, { booth_id: boothId, action: 'created' as const })
  })
}
