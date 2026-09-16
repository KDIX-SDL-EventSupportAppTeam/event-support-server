import type { DbClient } from '../db/client.js'
import { dateToMysqlUtc } from './datetime.js'

/**
 * アプリ公開ゲート（`event_app_access`）の実効開放状態の算出と既定値生成。
 * 判定ロジックはここだけに置く（06-api.md ファイル配置表）。
 */

export type AppAccessMode = 'closed' | 'scheduled' | 'open'

export type AppAccessRow = {
  event_id: string
  mode: AppAccessMode
  app_opens_at: string | null
  app_closes_at: string | null
  pre_survey_closes_at: string | null
  updated_by: string | null
  updated_at: string
}

export type EffectiveAccess = {
  event_id: string
  is_open: boolean
  mode: AppAccessMode
  app_opens_at: string | null
  app_closes_at: string | null
  pre_survey_closes_at: string | null
  is_pre_survey_open: boolean
  server_time: string
}

/** MySQL DATETIME（UTC, 'YYYY-MM-DD HH:MM:SS'）→ ISO 8601 文字列。 */
function toIso(v: string | null): string | null {
  if (v === null) return null
  return `${String(v).replace(' ', 'T')}Z`
}

/**
 * `event_app_access` の行（無ければ null）から、実効開放状態を算出する。
 * 行が無いイベントは `mode='closed'` 相当として扱う（フォールバック。02-data-model.md）。
 *
 * ```
 * is_open =
 *   mode === 'open'      -> true
 *   mode === 'closed'    -> false
 *   mode === 'scheduled' -> app_opens_at !== null && now >= app_opens_at
 *                           && (app_closes_at === null || now < app_closes_at)
 * ```
 */
export function resolveEffectiveAccess(
  row: AppAccessRow | null,
  now: Date = new Date(),
): EffectiveAccess {
  const eventId = row?.event_id ?? ''
  const mode: AppAccessMode = row?.mode ?? 'closed'
  const appOpensAt = row?.app_opens_at ?? null
  const appClosesAt = row?.app_closes_at ?? null
  const preSurveyClosesAt = row?.pre_survey_closes_at ?? null

  let isOpen: boolean
  if (mode === 'open') {
    isOpen = true
  } else if (mode === 'closed') {
    isOpen = false
  } else {
    const nowMs = now.getTime()
    const opensMs = appOpensAt ? new Date(`${appOpensAt.replace(' ', 'T')}Z`).getTime() : NaN
    const closesMs = appClosesAt ? new Date(`${appClosesAt.replace(' ', 'T')}Z`).getTime() : null
    isOpen = Number.isFinite(opensMs) && nowMs >= opensMs && (closesMs === null || nowMs < closesMs)
  }

  // 事前アンケートの締切は設けない（初回ログイン時に必ず回答させる運用）。
  // `pre_survey_closes_at` 列は残っているが判定には使わず、常に受付中として返す。
  const isPreSurveyOpen = true

  return {
    event_id: eventId,
    is_open: isOpen,
    mode,
    app_opens_at: toIso(appOpensAt),
    app_closes_at: toIso(appClosesAt),
    pre_survey_closes_at: toIso(preSurveyClosesAt),
    is_pre_survey_open: isPreSurveyOpen,
    server_time: now.toISOString(),
  }
}

/** `event_app_access` から1イベント分の行を取得する。無ければ null。 */
export async function fetchAppAccessRow(db: DbClient, eventId: string): Promise<AppAccessRow | null> {
  const [rows] = await db.query(
    `SELECT event_id, mode, app_opens_at, app_closes_at, pre_survey_closes_at, updated_by, updated_at
     FROM event_app_access WHERE event_id = ? LIMIT 1`,
    [eventId],
  )
  const row = (rows as AppAccessRow[])[0]
  return row ?? null
}

/**
 * イベント作成時の既定値（02-data-model.md「既定値の投入」）。
 *
 * - `mode` = `closed`。開放は manager が開催直前に手動で切り替える（`PUT /admin/events/:id/app-access`）。
 *   配布 URL を踏んだ参加者は事前アンケートに答えたあと、開放されるまで開放待ちで止まる。
 * - `app_opens_at` = `date_start` の30分前。`closed` では判定に使わないが、`scheduled` へ
 *   切り替えたときの目安として残す。
 * - `pre_survey_closes_at` = null（締切なし）。かつては開催前日 23:59:59（JST）を入れていたが、
 *   開始日を当日に設定すると作成直後から回答を受け付けなくなるため、既定では締切を設けない。
 *
 * `dateStart` は MySQL DATETIME 文字列（UTC 格納）を渡す。
 */
export function buildDefaultAccessDefaults(dateStart: string): {
  mode: AppAccessMode
  app_opens_at: string
  pre_survey_closes_at: string | null
} {
  const startMs = new Date(`${dateStart.replace(' ', 'T')}Z`).getTime()
  if (!Number.isFinite(startMs)) {
    throw new Error('Invalid date_start')
  }
  const appOpensAt = new Date(startMs - 30 * 60 * 1000)

  return {
    mode: 'closed',
    app_opens_at: dateToMysqlUtc(appOpensAt),
    pre_survey_closes_at: null,
  }
}
