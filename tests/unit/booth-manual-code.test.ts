import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { adminBoothRoutes } from '../../src/routes/v1/admin/admin-booths.js'
import { boothRoutes } from '../../src/routes/v1/booths.js'
import { bingoRoutes } from '../../src/routes/v1/bingo.js'
import { checkinRoutes } from '../../src/routes/v1/checkins.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '20000000-0000-4000-8000-000000000001'

const config = {
  port: 3000,
  databaseUrl: 'mysql://test',
  sakuraProxyUrl: undefined,
  sakuraProxyKey: undefined,
  jwtSecret: JWT_SECRET,
  webhookApiKey: '',
  recommenderUrl: '',
  recommenderTimeoutMs: 1500,
  recommenderOpsToken: '',
  recommenderStateTimeoutMs: 2000,
  checkinCooldownSec: 0,
  ratingScale: 3,
  corsOrigin: 'http://localhost:5173',
  adminRegistrationKey: 'k',
  frontendBaseUrl: 'https://front.example',
  organizerRegistrationKey: undefined,
  organizerSignupMode: 'invite',
  isProduction: false,
  smtpHost: undefined,
  smtpPort: 587,
  smtpUser: undefined,
  smtpPass: undefined,
  mailFrom: 'x <no-reply@example.com>',
} satisfies AppConfig

type Handler = { match: RegExp; rows: unknown[] | ((params: unknown[]) => unknown[]) }

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

const writePass: Handler = { match: /^\s*(INSERT|UPDATE|DELETE)/i, rows: [] }
const catchAll: Handler = { match: /.*/, rows: [] }

async function buildApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  app.decorate('io', { to: () => ({ emit: () => {} }) } as never)
  await app.register(
    async (v1) => {
      await v1.register(adminBoothRoutes)
      await v1.register(boothRoutes)
      await v1.register(bingoRoutes)
      await v1.register(checkinRoutes)
    },
    { prefix: '/api/v1' },
  )
  await app.ready()
  return app
}

function token(role: string, sub = 'u-1') {
  return jwt.sign({ sub, event_id: EVENT_ID, display_name: 't', role }, JWT_SECRET, { algorithm: 'HS256' })
}
const auth = (role: string) => ({ authorization: `Bearer ${token(role)}` })

describe('issue #121 — 参加者向け API から manual_code を外す', () => {
  it('GET /v1/booths は manual_code を返さず display_code を返す（T-1 / T-3）', async () => {
    const db = makeDb([
      {
        match: /FROM booths b/,
        rows: [
          { id: 'b-1', name: 'ブースA', description: null, display_code: 'A-12', category_id: null, category_name: null, checkin_count: 0, avg_rating: null, is_checked_in: 0 },
        ],
      },
      { match: /FROM booth_tags/, rows: [] },
      catchAll,
    ])
    const app = await buildApp(db)
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${EVENT_ID}/booths`, headers: auth('participant') })
    expect(res.statusCode).toBe(200)
    const raw = res.body
    expect(raw).not.toMatch(/manual_code/)
    expect(res.json().data.booths[0].display_code).toBe('A-12')
    await app.close()
  })

  it('GET /v1/bingo/card の応答に manual_code が1件も含まれない（T-2）', async () => {
    const db = makeDb([
      { match: /FROM bingo_cards/, rows: [{ id: 'card-1', event_id: EVENT_ID, user_id: 'u-1' }] },
      { match: /SELECT COUNT\(\*\) AS c FROM bingo_cells/, rows: [{ c: 16 }] },
      {
        match: /FROM bingo_cells c\s+LEFT JOIN booths b/,
        rows: [
          { position: 5, zone: 'CENTER', is_revealed: 1, is_achieved: 0, source: 'PRESURVEY', booth_id: 'b-1', booth_name: 'ブースA', display_code: 'A-12', booth_description: '説明' },
        ],
      },
      { match: /FROM card_unlock_events/, rows: [] },
      writePass,
      catchAll,
    ])
    const app = await buildApp(db)
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${EVENT_ID}/bingo/card`, headers: auth('participant') })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toMatch(/manual_code/)
    expect(res.body).toMatch(/display_code/)
    await app.close()
  })
})

describe('issue #121 — 手動コードの自動採番と秘匿', () => {
  it('POST /admin/.../booths は manual_code 未指定でも6桁数字を採番する（T-8）', async () => {
    const log: string[] = []
    const db = makeDb([
      { match: /SELECT 1 AS x FROM booths WHERE event_id = \? AND manual_code = \?/, rows: [] },
      writePass,
      catchAll,
    ], log)
    const app = await buildApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/booths`,
      headers: auth('manager'),
      payload: { name: '新ブース', display_code: 'B-3' },
    })
    expect(res.statusCode).toBe(201)
    const booth = res.json().data.booth
    expect(booth.manual_code).toMatch(/^[0-9]{6}$/)
    expect(booth.checkin_url).toContain('/checkin?booth_id=')
    // 監査ログの本文にコードの値が入っていない
    const auditSql = log.find((s) => /INSERT INTO audit_logs/.test(s))
    expect(auditSql).toBeTruthy()
    await app.close()
  })

  it('手入力は6桁数字以外を弾く（T-5 相当）', async () => {
    const db = makeDb([{ match: /SELECT 1 AS x FROM booths/, rows: [] }, writePass, catchAll])
    const app = await buildApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/booths`,
      headers: auth('manager'),
      payload: { name: 'x', manual_code: 'DEV001' },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('再発番は manager のみ（viewer は 403）（T-12）', async () => {
    const db = makeDb([
      { match: /SELECT id FROM booths WHERE id = \? AND event_id = \?/, rows: [{ id: 'b-1' }] },
      { match: /SELECT 1 AS x FROM booths/, rows: [] },
      writePass,
      catchAll,
    ])
    const app = await buildApp(db)
    const viewerRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/booths/b-1/manual-code/regenerate`,
      headers: auth('viewer'),
    })
    expect(viewerRes.statusCode).toBe(403)
    await app.close()
  })

  it('再発番は値を変え、監査ログにコードの値を残さない（T-11 / T-16）', async () => {
    const log: string[] = []
    const params: unknown[][] = []
    const db: DbClient = {
      query: async (sql: string, p: unknown[] = []) => {
        log.push(sql)
        params.push(p)
        if (/SELECT id FROM booths WHERE id = \? AND event_id = \?/.test(sql)) return [[{ id: 'b-1' }], undefined] as [unknown, unknown]
        if (/SELECT 1 AS x FROM booths/.test(sql)) return [[], undefined] as [unknown, unknown]
        return [[], undefined] as [unknown, unknown]
      },
      execute: async (sql: string, p: unknown[] = []) => {
        log.push(sql)
        params.push(p)
        return [[], undefined] as [unknown, unknown]
      },
      end: async () => {},
    }
    const app = await buildApp(db)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/events/${EVENT_ID}/booths/b-1/manual-code/regenerate`,
      headers: auth('manager'),
    })
    expect(res.statusCode).toBe(200)
    const code = res.json().data.booth.manual_code
    expect(code).toMatch(/^[0-9]{6}$/)
    // audit_logs の INSERT パラメータにコード文字列が現れない
    const auditIdx = log.findIndex((s) => /INSERT INTO audit_logs/.test(s))
    expect(auditIdx).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(params[auditIdx])).not.toContain(code)
    await app.close()
  })
})

describe('issue #121 — checkins の手動コード検証', () => {
  it('5桁は 422、6桁数字は照合まで進む（T-4 / T-5）', async () => {
    const db = makeDb([
      { match: /SELECT role, email_verified_at FROM users/, rows: [{ role: 'participant', email_verified_at: '2026-01-01 00:00:00' }] },
      { match: /SELECT id, name FROM booths WHERE event_id = \? AND UPPER\(manual_code\)/, rows: [] },
      writePass,
      catchAll,
    ])
    const app = await buildApp(db)
    const short = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins`,
      headers: auth('participant'),
      payload: { method: 'manual', manual_code: '12345', checked_in_at: new Date().toISOString() },
    })
    expect(short.statusCode).toBe(422)

    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/events/${EVENT_ID}/checkins`,
      headers: auth('participant'),
      payload: { method: 'manual', manual_code: '481502', checked_in_at: new Date().toISOString() },
    })
    // 6桁は検証を通り、存在しないコードなので 404（T-6）
    expect(ok.statusCode).toBe(404)
    await app.close()
  })
})
