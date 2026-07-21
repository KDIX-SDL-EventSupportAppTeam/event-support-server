import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { checkinRoutes } from '../../src/routes/v1/checkins.js'
import { commentsQuery, selectBoothComments } from '../../src/lib/booth-comments.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '20000000-0000-4000-8000-000000000001'
const BOOTH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CHECKIN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const config = {
  port: 3000,
  databaseUrl: 'mysql://test',
  sakuraProxyUrl: undefined,
  sakuraProxyKey: undefined,
  jwtSecret: JWT_SECRET,
  webhookApiKey: '',
  recommenderUrl: '',
  corsOrigin: 'http://localhost:5173',
  adminRegistrationKey: 'k',
  frontendBaseUrl: 'https://front.example',
  organizerRegistrationKey: undefined,
  organizerSignupMode: 'invite',
} satisfies AppConfig

type Handler = {
  match: RegExp
  rows: unknown[] | ((params: unknown[]) => unknown[])
}

/** SQL 文字列をパターン照合して結果を返す DbClient モック（tests/unit/exhibitor.test.ts と同じ流儀）。 */
function makeDb(handlers: Handler[], log?: string[]): DbClient {
  const run = async (sql: string, params: unknown[] = []) => {
    log?.push(sql)
    const h = handlers.find((x) => x.match.test(sql))
    if (!h) throw new Error(`unmatched SQL: ${sql}`)
    const rows = typeof h.rows === 'function' ? h.rows(params) : h.rows
    return [rows, undefined] as [unknown, unknown]
  }
  return { query: run, execute: run, end: async () => {} }
}

async function buildTestApp(db: DbClient) {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  // rating:new emit 用のスタブ（socket.io 未起動のテストでは app.io を最小実装で埋める）
  app.decorate('io', { to: () => ({ emit: () => {} }) } as unknown as FastifyInstance['io'])
  await app.register(
    async (v1) => {
      await v1.register(checkinRoutes)
    },
    { prefix: '/api/v1' },
  )
  await app.ready()
  return app
}

function signToken(payload: { sub: string; event_id: string; display_name?: string; role?: string }): string {
  return jwt.sign(
    { display_name: '', ...payload },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' },
  )
}
const participantAuth = (sub = 'p-1') => ({
  authorization: `Bearer ${signToken({ sub, event_id: EVENT_ID, role: 'participant' })}`,
})

const findCheckinHandler: Handler = {
  match: /FROM check_ins ci/,
  rows: [{ booth_id: BOOTH_ID, booth_name: 'ブースA' }],
}
const noDupRatingHandler: Handler = {
  match: /SELECT id FROM booth_ratings WHERE checkin_id/,
  rows: [],
}

describe('POST rating の comment 正規化（§4-1）', () => {
  it('空白のみの comment は trim 後に NULL として INSERT される', async () => {
    const insertParams: unknown[][] = []
    const db = makeDb([
      findCheckinHandler,
      noDupRatingHandler,
      {
        match: /INSERT INTO booth_ratings/,
        rows: (params) => {
          insertParams.push(params)
          return []
        },
      },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins/${CHECKIN_ID}/rating`,
      headers: participantAuth(),
      payload: { rating: 4, comment: '   ' },
    })
    expect(res.statusCode).toBe(200)
    expect(insertParams[0]?.at(-1)).toBeNull()
    await app.close()
  })

  it('comment を省略しても 200・INSERT の comment は NULL', async () => {
    const insertParams: unknown[][] = []
    const db = makeDb([
      findCheckinHandler,
      noDupRatingHandler,
      {
        match: /INSERT INTO booth_ratings/,
        rows: (params) => {
          insertParams.push(params)
          return []
        },
      },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins/${CHECKIN_ID}/rating`,
      headers: participantAuth(),
      payload: { rating: 4 },
    })
    expect(res.statusCode).toBe(200)
    expect(insertParams[0]?.at(-1)).toBeNull()
    await app.close()
  })

  it('前後空白のある comment は trim されて INSERT される', async () => {
    const insertParams: unknown[][] = []
    const db = makeDb([
      findCheckinHandler,
      noDupRatingHandler,
      {
        match: /INSERT INTO booth_ratings/,
        rows: (params) => {
          insertParams.push(params)
          return []
        },
      },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins/${CHECKIN_ID}/rating`,
      headers: participantAuth(),
      payload: { rating: 4, comment: '  展示が分かりやすかった  ' },
    })
    expect(res.statusCode).toBe(200)
    expect(insertParams[0]?.at(-1)).toBe('展示が分かりやすかった')
    await app.close()
  })

  it('501文字の comment は zod 不合格で 422 VALIDATION_ERROR（INSERT は発行されない）', async () => {
    const db = makeDb([findCheckinHandler, noDupRatingHandler])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins/${CHECKIN_ID}/rating`,
      headers: participantAuth(),
      payload: { rating: 4, comment: 'a'.repeat(501) },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    await app.close()
  })

  it('ちょうど500文字の comment は許可される', async () => {
    const insertParams: unknown[][] = []
    const db = makeDb([
      findCheckinHandler,
      noDupRatingHandler,
      {
        match: /INSERT INTO booth_ratings/,
        rows: (params) => {
          insertParams.push(params)
          return []
        },
      },
    ])
    const app = await buildTestApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins/${CHECKIN_ID}/rating`,
      headers: participantAuth(),
      payload: { rating: 4, comment: 'a'.repeat(500) },
    })
    expect(res.statusCode).toBe(200)
    expect(insertParams[0]?.at(-1)).toBe('a'.repeat(500))
    await app.close()
  })
})

describe('commentsQuery zod（§4-4、両GET共通）', () => {
  it('未指定時は既定値 {limit:20, offset:0}', () => {
    const parsed = commentsQuery.safeParse({})
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({ limit: 20, offset: 0 })
    }
  })

  it('limit=100 は max(50) を超えるため zod 不合格 → 呼び出し側で既定値 {20,0} にフォールバックする', () => {
    const parsed = commentsQuery.safeParse({ limit: '100' })
    expect(parsed.success).toBe(false)
    const fallback = parsed.success ? parsed.data : { limit: 20, offset: 0 }
    expect(fallback).toEqual({ limit: 20, offset: 0 })
  })

  it('offset=-1 は min(0) を下回るため zod 不合格', () => {
    const parsed = commentsQuery.safeParse({ offset: '-1' })
    expect(parsed.success).toBe(false)
  })

  it('文字列で渡された limit/offset を数値に coerce する', () => {
    const parsed = commentsQuery.safeParse({ limit: '30', offset: '10' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({ limit: 30, offset: 10 })
    }
  })
})

describe('selectBoothComments の includeHidden 切り替え（D3）', () => {
  it('includeHidden=false のとき COUNT・本体SELECT の両方に is_hidden = 0 を付与する', async () => {
    const log: string[] = []
    const db = makeDb(
      [
        { match: /SELECT COUNT\(\*\) AS total/, rows: [{ total: 3 }] },
        {
          match: /SELECT br\.id/,
          rows: [
            {
              id: 'r1',
              rating: 5,
              comment: '良かった',
              is_hidden: 0,
              user_display_name: '田中',
              rated_at: '2026-07-07 01:00:00',
            },
          ],
        },
      ],
      log,
    )
    const { rows, total } = await selectBoothComments(db, EVENT_ID, BOOTH_ID, 20, 0, false)
    expect(total).toBe(3)
    expect(rows).toHaveLength(1)
    expect(log.length).toBe(2)
    expect(log.every((sql) => /is_hidden = 0/.test(sql))).toBe(true)
  })

  it('includeHidden=true のとき is_hidden によるフィルタを付与しない', async () => {
    const log: string[] = []
    const db = makeDb(
      [
        { match: /SELECT COUNT\(\*\) AS total/, rows: [{ total: 5 }] },
        { match: /SELECT br\.id/, rows: [] },
      ],
      log,
    )
    await selectBoothComments(db, EVENT_ID, BOOTH_ID, 20, 0, true)
    expect(log.length).toBe(2)
    expect(log.every((sql) => !/is_hidden = 0/.test(sql))).toBe(true)
  })

  it('limit/offset は直埋めし、プレースホルダは event_id/booth_id のみ（さくら地雷対策）', async () => {
    const seenParams: unknown[][] = []
    const log: string[] = []
    const db = makeDb(
      [
        { match: /SELECT COUNT\(\*\) AS total/, rows: [{ total: 0 }] },
        {
          match: /SELECT br\.id/,
          rows: (params) => {
            seenParams.push(params)
            return []
          },
        },
      ],
      log,
    )
    await selectBoothComments(db, EVENT_ID, BOOTH_ID, 20, 40, true)
    expect(seenParams[0]).toEqual([EVENT_ID, BOOTH_ID])
    const listSql = log[1]
    expect(listSql).toContain('LIMIT 20 OFFSET 40')
    expect(listSql).not.toContain('LIMIT ?')
  })

  it('limit/offset の範囲外値は安全にクランプされる（共有ライブラリの防御）', async () => {
    const log: string[] = []
    const db = makeDb(
      [
        { match: /SELECT COUNT\(\*\) AS total/, rows: [{ total: 0 }] },
        { match: /SELECT br\.id/, rows: [] },
      ],
      log,
    )
    await selectBoothComments(db, EVENT_ID, BOOTH_ID, 999, -5, true)
    expect(log[1]).toContain('LIMIT 50 OFFSET 0')
  })
})
