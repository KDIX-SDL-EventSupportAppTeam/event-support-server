/**
 * 推薦エンジンの `/ops/state` を中継するための取得層。
 * docs/specs/recommender-phase-linkage/01-ops-state-relay.md が正本。
 *
 * 方針:
 * - サーバーは値を作らない・補正しない・推測しない。エンジンの応答をそのまま入れる
 * - 到達できないときは理由（reason）を区別して返す
 * - 例外を投げない。ルートは常に 200 で available:false を返せる
 * - 同一プロセス内で 10 秒キャッシュする（プロセス単位。推薦エンジンは1イベントしか見ない）
 * - `RECOMMENDER_OPS_TOKEN` の値は応答にもログにも出さない
 */
import type { AppConfig } from '../../config.js'

export type RecommenderStateReason =
  | 'UNCONFIGURED'
  | 'UNAUTHORIZED'
  | 'UNREACHABLE'
  | 'BAD_RESPONSE'

export type RecommenderStateResult =
  | { available: true; fetched_at: string; state: unknown }
  | { available: false; reason: RecommenderStateReason; fetched_at: string }

export interface OpsStateDeps {
  /** ミリ秒。テスト用に差し替え可能。 */
  now?: () => number
  /** テスト用に差し替え可能。 */
  fetchImpl?: typeof fetch
}

/** 同一プロセス内キャッシュの寿命。 */
export const OPS_STATE_CACHE_TTL_MS = 10_000

let cache: { at: number; result: RecommenderStateResult } | null = null

/** テスト用: プロセスキャッシュを空にする。 */
export function __resetOpsStateCacheForTests(): void {
  cache = null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

async function fetchOnce(
  config: AppConfig,
  fetchImpl: typeof fetch,
  isoNow: string,
): Promise<RecommenderStateResult> {
  const baseUrl = config.recommenderUrl.trim()
  if (!baseUrl) {
    return { available: false, reason: 'UNCONFIGURED', fetched_at: isoNow }
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/ops/state`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.recommenderStateTimeoutMs)

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      // Authorization は使わない（Cloud Run の IAM 認証と層が衝突するため）。
      headers: { 'x-ops-token': config.recommenderOpsToken },
      signal: controller.signal,
    })
  } catch {
    // 接続失敗・タイムアウト（AbortController の abort もここに来る）
    return { available: false, reason: 'UNREACHABLE', fetched_at: isoNow }
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 401 || res.status === 403) {
    return { available: false, reason: 'UNAUTHORIZED', fetched_at: isoNow }
  }
  if (!res.ok) {
    // 想定外のステータス。バージョン不一致を疑う。
    return { available: false, reason: 'BAD_RESPONSE', fetched_at: isoNow }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { available: false, reason: 'BAD_RESPONSE', fetched_at: isoNow }
  }
  if (!isRecord(body)) {
    return { available: false, reason: 'BAD_RESPONSE', fetched_at: isoNow }
  }

  return { available: true, fetched_at: isoNow, state: body }
}

/**
 * 推薦エンジンの状態を取得する。10 秒キャッシュ。例外を投げない。
 */
export async function getRecommenderOpsState(
  config: AppConfig,
  deps: OpsStateDeps = {},
): Promise<RecommenderStateResult> {
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetchImpl ?? fetch
  const t = now()

  if (cache && t - cache.at < OPS_STATE_CACHE_TTL_MS) {
    return cache.result
  }

  const result = await fetchOnce(config, fetchImpl, new Date(t).toISOString())
  cache = { at: t, result }
  return result
}
