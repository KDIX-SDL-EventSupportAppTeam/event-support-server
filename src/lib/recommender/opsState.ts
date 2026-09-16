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

/**
 * 取得中の Promise ごとキャッシュする。**結果だけをキャッシュすると足りない。**
 * ダッシュボードは WebSocket で頻繁に再取得するため、キャッシュが冷えている瞬間に
 * 同時到着した N 本が全部エンジンを叩いてしまう（推薦エンジンが遅い・落ちているときほど
 * 窓が広がり、まさに守りたい場面で漏れる）。
 */
let cache: { at: number; inflight: Promise<RecommenderStateResult> } | null = null

/** テスト用: プロセスキャッシュを空にする。 */
export function __resetOpsStateCacheForTests(): void {
  cache = null
}

/** 配列は「形が違う」＝ BAD_RESPONSE。/ops/state はオブジェクトを返す契約。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
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
  // タイムアウトはボディ読み取りまでを覆う。ヘッダだけ返してボディが止まる相手に
  // 張り付かないため（recommenderClient.ts と同じ流儀）。
  const timer = setTimeout(() => controller.abort(), config.recommenderStateTimeoutMs)

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      // Authorization は使わない（Cloud Run の IAM 認証と層が衝突するため）。
      headers: { 'x-ops-token': config.recommenderOpsToken },
      signal: controller.signal,
    })

    if (res.status === 401 || res.status === 403) {
      return { available: false, reason: 'UNAUTHORIZED', fetched_at: isoNow }
    }
    if (!res.ok) {
      // 想定外のステータス。バージョン不一致を疑う。
      return { available: false, reason: 'BAD_RESPONSE', fetched_at: isoNow }
    }

    // ボディが JSON でない / 形が違う → BAD_RESPONSE。
    // ただしボディ読み取りが abort された場合は「届かなかった」= UNREACHABLE に倒す。
    let body: unknown
    try {
      body = await res.json()
    } catch {
      if (controller.signal.aborted) {
        return { available: false, reason: 'UNREACHABLE', fetched_at: isoNow }
      }
      return { available: false, reason: 'BAD_RESPONSE', fetched_at: isoNow }
    }
    if (!isRecord(body)) {
      return { available: false, reason: 'BAD_RESPONSE', fetched_at: isoNow }
    }

    return { available: true, fetched_at: isoNow, state: body }
  } catch {
    // 接続失敗・タイムアウト（AbortController の abort もここに来る）
    return { available: false, reason: 'UNREACHABLE', fetched_at: isoNow }
  } finally {
    clearTimeout(timer)
  }
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
    return cache.inflight
  }

  // 先に cache へ入れてから await する。こうしないと同時到着分が素通りする。
  const inflight = fetchOnce(config, fetchImpl, new Date(t).toISOString())
  cache = { at: t, inflight }
  try {
    return await inflight
  } catch (e) {
    // fetchOnce は例外を投げない設計だが、投げたときにキャッシュを壊れたまま
    // 10 秒間居座らせない（次の呼び出しで取り直せるようにする）。
    if (cache?.inflight === inflight) cache = null
    throw e
  }
}
