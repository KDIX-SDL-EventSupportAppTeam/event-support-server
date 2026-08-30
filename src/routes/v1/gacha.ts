import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sendFail, sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'
import { findCard } from '../../lib/bingo/ensureCard.js'
import { countCompletedLines } from '../../lib/bingo/lines.js'
import { calcCoinsEarned } from '../../lib/gacha/coins.js'
import { fetchGachaSettings } from '../../lib/gacha/settings.js'
import { NoCoinsAvailableError, useCoin } from '../../lib/gacha/useCoin.js'

/**
 * 参加者向けガチャコイン API。
 *
 * コインは残高カラムを持たず、`gacha_coin_uses` の追記のみで表す。
 * `available = max(0, earned - used)` を毎回導出する（G-1）。
 * ライン数からコイン枚数への換算はガチャ側の純関数 calcCoinsEarned が担う（G-4）。
 *
 * 仕様: docs/specs/gacha-and-award/04-api/participant-api.md
 */
export async function gachaRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

  /**
   * そのユーザーの成立ライン数を、ビンゴカードから求める。
   *
   * カードが無ければ 0 を返し、**ここでは作らない**。コイン枚数の問い合わせが
   * ビンゴカードを生成するのは責務として誤りで、ホーム初回表示で
   * `GET /bingo/card` と同時に走ると同一ユーザーの ensureCard が二重に競合する
   * （カード未生成 = ライン0 なので、読み取りだけで意味的にも正しい）。
   */
  async function countLines(eventId: string, uid: string): Promise<number> {
    const card = await findCard(app.db, eventId, uid)
    if (!card) return 0
    const [rows] = await app.db.query(
      `SELECT position FROM bingo_cells WHERE card_id = ? AND is_achieved = 1`,
      [card.id],
    )
    const achieved = new Set((rows as { position: number }[]).map((r) => r.position))
    return countCompletedLines(achieved)
  }

  /** そのユーザーの使用枚数（台帳の行数）。 */
  async function countUsed(eventId: string, uid: string): Promise<number> {
    const [rows] = await app.db.query(
      `SELECT COUNT(*) AS c FROM gacha_coin_uses WHERE event_id = ? AND user_id = ?`,
      [eventId, uid],
    )
    return Number((rows as { c: number }[])[0]?.c ?? 0)
  }

  function basePayload(args: {
    isEnabled: boolean
    linesCompleted: number
    earned: number
    used: number
    maxCoins: number
  }) {
    return {
      is_enabled: args.isEnabled,
      lines_completed: args.linesCompleted,
      earned: args.earned,
      used: args.used,
      available: Math.max(0, args.earned - args.used),
      max_coins: args.maxCoins,
    }
  }

  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/gacha/coins',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub

      const settings = await fetchGachaSettings(app.db, eventId)
      const linesCompleted = await countLines(eventId, uid)
      const used = await countUsed(eventId, uid)
      const earned = calcCoinsEarned(linesCompleted, settings)

      // is_enabled = false でも 200 を返す。UI 側で「準備中」を出す。
      return sendOk(
        reply,
        basePayload({
          isEnabled: settings.isEnabled,
          linesCompleted,
          earned,
          used,
          maxCoins: settings.maxCoins,
        }),
      )
    },
  )

  const useBody = z.object({ idempotency_key: z.string().uuid() })

  app.post<{ Params: { event_id: string } }>(
    '/events/:event_id/gacha/coins/use',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub

      const parsed = useBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 400, 'INVALID_BODY', 'idempotency_key は UUID 形式で必須です')
      }
      const idempotencyKey = parsed.data.idempotency_key

      // 手順1: 設定を読む。is_enabled = 0 なら 403
      const settings = await fetchGachaSettings(app.db, eventId)
      if (!settings.isEnabled) {
        return sendFail(reply, 403, 'GACHA_DISABLED', 'ガチャは現在準備中です')
      }

      // 手順2〜4: 消費。earned は手順2でその場算出し、再試行時も再評価する。
      // 応答用にも使うため、最後に評価したライン数・獲得枚数を控える
      // （消費後にもう一度 countLines するとカード取得を含む3クエリを余計に往復するため）。
      let lastLines = 0
      let lastEarned = 0
      let result
      try {
        result = await useCoin(app.db, {
          eventId,
          userId: uid,
          idempotencyKey,
          computeEarned: async () => {
            lastLines = await countLines(eventId, uid)
            lastEarned = calcCoinsEarned(lastLines, settings)
            return lastEarned
          },
        })
      } catch (err) {
        if (err instanceof NoCoinsAvailableError) {
          return sendFail(reply, 409, 'NO_COINS_AVAILABLE', '使用できるコインがありません')
        }
        throw err
      }

      const linesCompleted = lastLines
      const earned = lastEarned
      // used だけは数え直す（coin_index + 1 で代用しない: 同一ユーザーの並行消費が
      // 先に入っていると実際の使用枚数はそれより多く、古い値を返してしまうため）。
      const used = await countUsed(eventId, uid)

      return sendOk(reply, {
        ...basePayload({
          isEnabled: settings.isEnabled,
          linesCompleted,
          earned,
          used,
          maxCoins: settings.maxCoins,
        }),
        coin_index: result.coinIndex,
        used_at: result.usedAt,
      })
    },
  )
}
