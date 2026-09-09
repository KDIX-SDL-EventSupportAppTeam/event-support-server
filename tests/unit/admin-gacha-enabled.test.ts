import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { adminGachaRoutes } from '../../src/routes/v1/admin/gacha.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '20000000-0000-4000-8000-000000000001'

const config = { jwtSecret: JWT_SECRET } as unknown as AppConfig

type Call = { sql: string; params: unknown[] }

function makeDb(handler: (sql: string, params: unknown[]) => unknown[], calls: Call[]): DbClient {
  const run = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    return [handler(sql, params), undefined] as [unknown, unknown]
  }
  return { query: run, execute: run, end: async () => {} }
}

async function buildApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(async (v1) => { await v1.register(adminGachaRoutes) }, { prefix: '/api/v1' })
  await app.ready()
  return app
}

function auth(role: string) {
  return { authorization: `Bearer ${jwt.sign({ sub: `${role}-1`, event_id: EVENT_ID, display_name: 't', role }, JWT_SECRET, { algorithm: 'HS256' })}` }
}

/** gacha_settings に既存行があるケースの handler。 */
function settingsRowHandler(isEnabled: number) {
  return (sql: string) => {
    if (/FROM gacha_settings/.test(sql)) {
      return [{ is_enabled: isEnabled, coins_per_line: 2, max_coins: 6, bonus_coins: 1 }]
    }
    return []
  }
}

describe('PATCH /admin/events/:event_id/gacha/enabled（issue #122）', () => {
  it('manager が is_enabled:false を送ると upsert され 200（T-1）', async () => {
    const calls: Call[] = []
    let enabled = 1
    const db = makeDb((sql) => {
      if (/INSERT INTO gacha_settings/.test(sql)) { enabled = 0; return [] }
      if (/FROM gacha_settings/.test(sql)) return [{ is_enabled: enabled, coins_per_line: 2, max_coins: 6, bonus_coins: 1 }]
      return []
    }, calls)
    const app = await buildApp(db)
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/events/${EVENT_ID}/gacha/enabled`,
      headers: auth('manager'), payload: { is_enabled: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.is_enabled).toBe(false)
    await app.close()
  })

  it('coins_per_line / max_coins / bonus_coins は変えない（T-5）', async () => {
    const calls: Call[] = []
    const db = makeDb(settingsRowHandler(1), calls)
    const app = await buildApp(db)
    await app.inject({
      method: 'PATCH', url: `/api/v1/admin/events/${EVENT_ID}/gacha/enabled`,
      headers: auth('manager'), payload: { is_enabled: false },
    })
    const insert = calls.find((c) => /INSERT INTO gacha_settings/.test(c.sql))!
    // params: [eventId, is_enabled, coins_per_line, max_coins, bonus_coins] = 既存値を維持
    expect(insert.params).toEqual([EVENT_ID, 0, 2, 6, 1])
    // 更新句は is_enabled のみ
    expect(insert.sql).toMatch(/ON DUPLICATE KEY UPDATE is_enabled = VALUES\(is_enabled\)/)
    await app.close()
  })

  it('viewer は 403（T-3）', async () => {
    const app = await buildApp(makeDb(settingsRowHandler(1), []))
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/events/${EVENT_ID}/gacha/enabled`,
      headers: auth('viewer'), payload: { is_enabled: false },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('participant は 403（T-4）', async () => {
    const app = await buildApp(makeDb(settingsRowHandler(1), []))
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/events/${EVENT_ID}/gacha/enabled`,
      headers: auth('participant'), payload: { is_enabled: false },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('操作が監査ログに残る（T-7）', async () => {
    const calls: Call[] = []
    const db = makeDb(settingsRowHandler(1), calls)
    const app = await buildApp(db)
    await app.inject({
      method: 'PATCH', url: `/api/v1/admin/events/${EVENT_ID}/gacha/enabled`,
      headers: auth('manager'), payload: { is_enabled: false },
    })
    const audit = calls.find((c) => /INSERT INTO audit_logs/.test(c.sql))
    expect(audit).toBeTruthy()
    expect(JSON.stringify(audit!.params)).toContain('gacha.enabled.update')
    await app.close()
  })

  it('gacha_settings に行が無くても 200（T-10）', async () => {
    const calls: Call[] = []
    const db = makeDb((sql) => {
      if (/FROM gacha_settings/.test(sql)) return [] // 行なし → 既定値
      return []
    }, calls)
    const app = await buildApp(db)
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/events/${EVENT_ID}/gacha/enabled`,
      headers: auth('manager'), payload: { is_enabled: false },
    })
    expect(res.statusCode).toBe(200)
    const insert = calls.find((c) => /INSERT INTO gacha_settings/.test(c.sql))!
    // 既定値（coins_per_line=1, max_coins=4, bonus_coins=0）を土台に upsert
    expect(insert.params).toEqual([EVENT_ID, 0, 1, 4, 0])
    await app.close()
  })
})

describe('GET /admin/events/:event_id/gacha/stats（issue #122 拡張）', () => {
  it('is_enabled と total_earned を返す（T-8）', async () => {
    const calls: Call[] = []
    const db = makeDb((sql) => {
      if (/COUNT\(\*\) AS total_used/.test(sql)) return [{ total_used: 0, users_who_used: 0 }]
      if (/DATE_FORMAT\(used_at/.test(sql)) return []
      if (/FROM gacha_settings/.test(sql)) return [{ is_enabled: 0, coins_per_line: 1, max_coins: 4, bonus_coins: 0 }]
      if (/JOIN bingo_cells cell/.test(sql)) {
        // 1人が全16マス達成 → 4ライン以上 → earned = min(lines*1, max_coins=4) = 4
        return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((position) => ({ user_id: 'p-1', position }))
      }
      return []
    }, calls)
    const app = await buildApp(db)
    const res = await app.inject({
      method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/gacha/stats`, headers: auth('viewer'),
    })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.is_enabled).toBe(false)
    expect(data.total_earned).toBe(4)
    await app.close()
  })
})
