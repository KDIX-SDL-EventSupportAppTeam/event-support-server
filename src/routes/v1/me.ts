import type { FastifyInstance } from 'fastify'
import { sendOk } from '../../lib/response.js'
import { requireBearerAuth, requireEventMatchesJwt } from '../../plugins/auth.js'
import { fetchAppAccessRow, resolveEffectiveAccess } from '../../lib/app-access.js'
import { dateToMysqlUtc } from '../../lib/datetime.js'

/**
 * 参加者自身の進行状態。単一 URL（配布リンク）の分岐材料をこの 1 本にまとめる（PQ-2 案 B）。
 *
 * フロントは配布リンクを踏むたびにこれを呼び、
 * 「メール確認 → 回答 → 開放待ち → オンボーディング」のどの段階にいるかを決める。
 * 段階ごとに別 API を叩くと往復が増え、判定がクライアント側に散るため 1 本に寄せている。
 */

type UserRow = { email_verified_at: string | null; onboarding_completed_at: string | null }
type AnswerRow = { created_at: string | null }

/** MySQL DATETIME（UTC, 'YYYY-MM-DD HH:MM:SS'）→ ISO 8601。lib/app-access.ts の toIso と同式。 */
function toIso(v: string | null): string | null {
  if (v === null) return null
  return `${String(v).replace(' ', 'T')}Z`
}

export async function meRoutes(app: FastifyInstance) {
  const pre = [requireBearerAuth, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/events/:event_id/me/state',
    { preHandler: pre },
    async (req, reply) => {
      const eventId = req.params.event_id
      const uid = req.jwtUser!.sub

      const [userRows] = await app.db.query(
        'SELECT email_verified_at, onboarding_completed_at FROM users WHERE id = ? LIMIT 1',
        [uid],
      )
      const user = (userRows as UserRow[])[0]

      const [answerRows] = await app.db.query(
        'SELECT created_at FROM user_survey_answers WHERE user_id = ? AND event_id = ? LIMIT 1',
        [uid, eventId],
      )
      const answer = (answerRows as AnswerRow[])[0]

      const effective = resolveEffectiveAccess(await fetchAppAccessRow(app.db, eventId))

      return sendOk(reply, {
        email_verified: Boolean(user?.email_verified_at),
        survey_answered: Boolean(answer),
        // 再回答は UPDATE で上書きするため、これは「最初に回答した時刻」（02-data-model.md）
        survey_answered_at: toIso(answer?.created_at ?? null),
        onboarding_completed: Boolean(user?.onboarding_completed_at),
        app_access: {
          is_open: effective.is_open,
          mode: effective.mode,
          app_opens_at: effective.app_opens_at,
          is_pre_survey_open: effective.is_pre_survey_open,
          pre_survey_closes_at: effective.pre_survey_closes_at,
          server_time: effective.server_time,
        },
      })
    },
  )

  /**
   * オンボーディング完了の打刻。最終スライド到達またはスキップで呼ぶ。
   * 既読を端末（localStorage）ではなくサーバーに持つのは、回答から開放まで数日空き、
   * その間に端末が変わり得るため（PC で回答 → 当日スマホ）。
   *
   * 2 回目以降の呼び出しは初回の時刻を保つ（冪等）。本番 DB はトランザクション不可のため
   * 条件付き UPDATE 1 本で済ませる（ADR 0001）。
   */
  app.post<{ Params: { event_id: string } }>(
    '/events/:event_id/me/onboarding',
    { preHandler: pre },
    async (req, reply) => {
      const uid = req.jwtUser!.sub
      await app.db.execute(
        'UPDATE users SET onboarding_completed_at = ? WHERE id = ? AND onboarding_completed_at IS NULL',
        [dateToMysqlUtc(new Date()), uid],
      )
      const [rows] = await app.db.query(
        'SELECT onboarding_completed_at FROM users WHERE id = ? LIMIT 1',
        [uid],
      )
      const row = (rows as { onboarding_completed_at: string | null }[])[0]
      return sendOk(reply, {
        onboarding_completed: Boolean(row?.onboarding_completed_at),
        onboarding_completed_at: toIso(row?.onboarding_completed_at ?? null),
      })
    },
  )
}
