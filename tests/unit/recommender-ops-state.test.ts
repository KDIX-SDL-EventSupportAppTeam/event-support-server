import { describe, expect, it, beforeEach, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import Fastify from 'fastify'
import {
  getRecommenderOpsState,
  __resetOpsStateCacheForTests,
} from '../../src/lib/recommender/opsState.js'
import { adminRecommenderStateRoutes } from '../../src/routes/v1/admin/recommender-state.js'
import type { AppConfig } from '../../src/config.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const OPS_TOKEN = 'super-secret-ops-token'

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    databaseUrl: 'mysql://test',
    jwtSecret: JWT_SECRET,
    webhookApiKey: '',
    recommenderUrl: 'https://recommend.example',
    recommenderTimeoutMs: 1000,
    recommenderOpsToken: OPS_TOKEN,
    recommenderStateTimeoutMs: 2000,
    checkinCooldownSec: 0,
    ratingScale: 4,
    corsOrigin: 'http://localhost:5173',
    adminRegistrationKey: 'k',
    organizerSignupMode: 'invite',
    ...over,
  } as unknown as AppConfig
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  __resetOpsStateCacheForTests()
})

describe('getRecommenderOpsState（中継の取得層）', () => {
  it('T-1 200 を返す → available:true と state がそのまま入る', async () => {
    const state = { phase: 'COVERAGE', decision_table_size: 3 }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, state))
    const res = await getRecommenderOpsState(makeConfig(), { fetchImpl, now: () => 0 })
    expect(res).toMatchObject({ available: true, state })
  })

  it('T-2 RECOMMENDER_URL が空 → available:false / reason:UNCONFIGURED（呼び出さない）', async () => {
    const fetchImpl = vi.fn()
    const res = await getRecommenderOpsState(makeConfig({ recommenderUrl: '' }), {
      fetchImpl,
      now: () => 0,
    })
    expect(res).toMatchObject({ available: false, reason: 'UNCONFIGURED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('T-3 401 → reason:UNAUTHORIZED', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'nope' }))
    const res = await getRecommenderOpsState(makeConfig(), { fetchImpl, now: () => 0 })
    expect(res).toMatchObject({ available: false, reason: 'UNAUTHORIZED' })
  })

  it('T-3b 403 も UNAUTHORIZED 扱い', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, {}))
    const res = await getRecommenderOpsState(makeConfig(), { fetchImpl, now: () => 0 })
    expect(res).toMatchObject({ available: false, reason: 'UNAUTHORIZED' })
  })

  it('T-4 接続不能・タイムアウト → reason:UNREACHABLE', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await getRecommenderOpsState(makeConfig(), { fetchImpl, now: () => 0 })
    expect(res).toMatchObject({ available: false, reason: 'UNREACHABLE' })
  })

  it('T-5 JSON でない応答 → reason:BAD_RESPONSE', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>oops</html>', { status: 200 }))
    const res = await getRecommenderOpsState(makeConfig(), { fetchImpl, now: () => 0 })
    expect(res).toMatchObject({ available: false, reason: 'BAD_RESPONSE' })
  })

  it('T-5b 5xx など想定外ステータス → BAD_RESPONSE', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: 'x' }))
    const res = await getRecommenderOpsState(makeConfig(), { fetchImpl, now: () => 0 })
    expect(res).toMatchObject({ available: false, reason: 'BAD_RESPONSE' })
  })

  it('T-7 X-Ops-Token を送る（Authorization は送らない）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { phase: 'COVERAGE' }))
    await getRecommenderOpsState(makeConfig(), { fetchImpl, now: () => 0 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://recommend.example/ops/state')
    const headers = init.headers as Record<string, string>
    expect(headers['x-ops-token']).toBe(OPS_TOKEN)
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization')
  })

  it('T-8 応答にトークンの値が出ない', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { phase: 'COVERAGE' }))
    const res = await getRecommenderOpsState(makeConfig(), { fetchImpl, now: () => 0 })
    expect(JSON.stringify(res)).not.toContain(OPS_TOKEN)
  })

  it('T-9 10秒以内の連続呼び出しでは推薦エンジンへのリクエストが1回だけ', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { phase: 'COVERAGE' }))
    let clock = 1000
    const now = () => clock
    await getRecommenderOpsState(makeConfig(), { fetchImpl, now })
    clock += 5000
    await getRecommenderOpsState(makeConfig(), { fetchImpl, now })
    clock += 4000
    await getRecommenderOpsState(makeConfig(), { fetchImpl, now })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('T-9b 同時到着（キャッシュが冷えている）でも推薦エンジンへのリクエストは1回だけ', async () => {
    // 結果だけをキャッシュしていると、await が解決する前に来た分が全部素通りする。
    let resolveFetch: (r: Response) => void = () => {}
    const fetchImpl = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve }),
    )
    const now = () => 1000

    const all = Promise.all([
      getRecommenderOpsState(makeConfig(), { fetchImpl, now }),
      getRecommenderOpsState(makeConfig(), { fetchImpl, now }),
      getRecommenderOpsState(makeConfig(), { fetchImpl, now }),
    ])
    resolveFetch(jsonResponse(200, { phase: 'COVERAGE' }))
    const results = await all

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // 3本とも同じ結果を受け取る
    for (const r of results) expect(r).toMatchObject({ available: true })
  })

  it('BAD_RESPONSE: 応答が配列（形が違う）→ available:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, [1, 2, 3]))
    const res = await getRecommenderOpsState(makeConfig(), { fetchImpl, now: () => 0 })
    expect(res).toMatchObject({ available: false, reason: 'BAD_RESPONSE' })
  })

  it('ボディ読み取り中にタイムアウトしたら UNREACHABLE（BAD_RESPONSE にしない）', async () => {
    // ヘッダは返るがボディが止まる相手。タイムアウトがボディまで覆っていないと張り付く。
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      return {
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted', 'AbortError')),
            )
          }),
      } as unknown as Response
    })
    const res = await getRecommenderOpsState(
      makeConfig({ recommenderStateTimeoutMs: 10 } as Partial<AppConfig>),
      { fetchImpl, now: () => 0 },
    )
    expect(res).toMatchObject({ available: false, reason: 'UNREACHABLE' })
  })

  it('T-10 10秒経過後は再取得する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { phase: 'COVERAGE' }))
    let clock = 1000
    const now = () => clock
    await getRecommenderOpsState(makeConfig(), { fetchImpl, now })
    clock += 10_001
    await getRecommenderOpsState(makeConfig(), { fetchImpl, now })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('GET /admin/events/:event_id/recommender/state（ルート）', () => {
  async function buildApp(config: AppConfig) {
    const app = Fastify()
    app.decorate('config', config)
    // db は本エンドポイントでは使わないが、preHandler が触らないので未デコレートで良い
    await app.register(adminRecommenderStateRoutes)
    await app.ready()
    return app
  }

  function token(role: string) {
    return jwt.sign({ sub: 'u1', role, event_id: EVENT_ID }, JWT_SECRET)
  }

  it('T-6 中継が失敗しても 500 を返さない（200 で available:false）', async () => {
    const app = await buildApp(makeConfig({ recommenderUrl: '' }))
    const res = await app.inject({
      method: 'GET',
      url: `/admin/events/${EVENT_ID}/recommender/state`,
      headers: { authorization: `Bearer ${token('manager')}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ available: false, reason: 'UNCONFIGURED' })
    await app.close()
  })

  it('T-11 参加者ロールのトークンでは 403', async () => {
    const app = await buildApp(makeConfig({ recommenderUrl: '' }))
    const res = await app.inject({
      method: 'GET',
      url: `/admin/events/${EVENT_ID}/recommender/state`,
      headers: { authorization: `Bearer ${token('participant')}` },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('viewer ロールは読める（運営スタッフ）', async () => {
    const app = await buildApp(makeConfig({ recommenderUrl: '' }))
    const res = await app.inject({
      method: 'GET',
      url: `/admin/events/${EVENT_ID}/recommender/state`,
      headers: { authorization: `Bearer ${token('viewer')}` },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})
