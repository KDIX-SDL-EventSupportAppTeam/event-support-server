import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireOrganizer } from '../../../plugins/auth.js'
import { assertEventOwnedByOrganizer } from '../../../lib/organizer.js'
import { insertAuditLog } from '../../../lib/audit.js'
import { fetchGachaSettings } from '../../../lib/gacha/settings.js'

/**
 * 運営（organizer）向けのガチャ換算規則 API。
 *
 * 当日「足りない／余る」と分かったとき、デプロイなしで運営が直せるようにする（G-3）。
 * 誤使用の救済は bonus_coins を +1 する運用（台帳から行は消さない）。
 *
 * 仕様: docs/specs/gacha-and-award/04-api/organizer-api.md
 */

const putBody = z.object({
  is_enabled: z.boolean(),
  coins_per_line: z.number().int().min(0).max(10),
  max_coins: z.number().int().min(0).max(50),
  bonus_coins: z.number().int().min(0).max(10),
})

function toResponse(s: {
  isEnabled: boolean
  coinsPerLine: number
  maxCoins: number
  bonusCoins: number
}) {
  return {
    is_enabled: s.isEnabled,
    coins_per_line: s.coinsPerLine,
    max_coins: s.maxCoins,
    bonus_coins: s.bonusCoins,
  }
}

export async function organizerGachaSettingsRoutes(app: FastifyInstance) {
  const pre = [requireOrganizer]

  app.get<{ Params: { event_id: string } }>(
    '/organizer/events/:event_id/gacha/settings',
    { preHandler: pre },
    async (req, reply) => {
      const organizerId = req.organizerUser!.sub
      const eventId = req.params.event_id
      if (!(await assertEventOwnedByOrganizer(app.db, eventId, organizerId))) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このイベントへのアクセス権限がありません')
      }
      // 行が無ければ既定値を返す（DEFAULT_GACHA_SETTINGS）
      const settings = await fetchGachaSettings(app.db, eventId)
      return sendOk(reply, toResponse(settings))
    },
  )

  app.put<{ Params: { event_id: string } }>(
    '/organizer/events/:event_id/gacha/settings',
    { preHandler: pre },
    async (req, reply) => {
      const organizerId = req.organizerUser!.sub
      const eventId = req.params.event_id
      if (!(await assertEventOwnedByOrganizer(app.db, eventId, organizerId))) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このイベントへのアクセス権限がありません')
      }

      const parsed = putBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 400, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data

      const before = toResponse(await fetchGachaSettings(app.db, eventId))

      // 行が無ければ INSERT、あれば UPDATE（単一 SQL）
      await app.db.execute(
        `INSERT INTO gacha_settings (event_id, is_enabled, coins_per_line, max_coins, bonus_coins)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           is_enabled = VALUES(is_enabled),
           coins_per_line = VALUES(coins_per_line),
           max_coins = VALUES(max_coins),
           bonus_coins = VALUES(bonus_coins)`,
        [
          eventId,
          body.is_enabled ? 1 : 0,
          body.coins_per_line,
          body.max_coins,
          body.bonus_coins,
        ],
      )

      const after = toResponse(await fetchGachaSettings(app.db, eventId))

      await insertAuditLog(app.db, {
        eventId,
        actorId: organizerId,
        actorRole: 'organizer',
        action: 'update',
        targetType: 'gacha_settings',
        targetId: eventId,
        detail: { before, after },
      })

      return sendOk(reply, after)
    },
  )
}
