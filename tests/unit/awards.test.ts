import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { awardRoutes } from '../../src/routes/v1/awards.js'
import { adminAwardRoutes } from '../../src/routes/v1/admin/awards.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '20000000-0000-4000-8000-000000000001'
const AWARD_ID = '30000000-0000-4000-8000-0000000000a1'
const BOOTH_OK = '40000000-0000-4000-8000-0000000000b1'
const BOOTH_NG = '40000000-0000-4000-8000-0000000000b2'

const config = { jwtSecret: JWT_SECRET } as unknown as AppConfig

type Call = { sql: string; params: unknown[] }
function makeDb(h: (sql: string, p: unknown[]) => unknown[], calls: Call[] = []): DbClient {
  const run = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    return [h(sql, params), undefined] as [unknown, unknown]
  }
  return { query: run, execute: run, end: async () => {} }
}

async function buildApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(async (v1) => {
    await v1.register(awardRoutes)
    await v1.register(adminAwardRoutes)
  }, { prefix: '/api/v1' })
  await app.ready()
  return app
}
function auth(role: string) {
  return { authorization: `Bearer ${jwt.sign({ sub: `${role}-1`, event_id: EVENT_ID, display_name: 't', role }, JWT_SECRET, { algorithm: 'HS256' })}` }
}

/** 参加者向けの標準 handler。is_open と checked-in ブースを差し替え可能。 */
function participantHandler(opts: { isOpen: number; checkedBoothId?: string; awardIds?: string[] }) {
  return (sql: string) => {
    if (/FROM award_settings/.test(sql)) return opts.isOpen === -1 ? [] : [{ is_open: opts.isOpen }]
    if (/FROM awards WHERE event_id = \?\s*$/.test(sql) || /SELECT id FROM awards WHERE event_id = \?/.test(sql)) {
      return (opts.awardIds ?? [AWARD_ID]).map((id) => ({ id }))
    }
    if (/SELECT id, name, description, color\s+FROM awards/.test(sql)) {
      return (opts.awardIds ?? [AWARD_ID]).map((id) => ({ id, name: '賞', description: null, color: 'pink' }))
    }
    if (/FROM check_ins ci\s+JOIN booths b/.test(sql)) {
      return opts.checkedBoothId ? [{ id: opts.checkedBoothId, name: 'B', description: null, display_code: null, category_id: null }] : []
    }
    if (/SELECT award_id, booth_id FROM award_votes/.test(sql)) return []
    return []
  }
}

describe('参加者 GET /events/:id/awards/vote（issue #124）', () => {
  it('award_settings に行が無くても 200・voting_open:false（T-1 / T-14）', async () => {
    const app = await buildApp(makeDb(participantHandler({ isOpen: -1 })))
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${EVENT_ID}/awards/vote`, headers: auth('participant') })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.voting_open).toBe(false)
    await app.close()
  })

  it('checked_booths に manual_code を含めない', async () => {
    const app = await buildApp(makeDb(participantHandler({ isOpen: 1, checkedBoothId: BOOTH_OK })))
    const res = await app.inject({ method: 'GET', url: `/api/v1/events/${EVENT_ID}/awards/vote`, headers: auth('participant') })
    expect(res.body).not.toMatch(/manual_code/)
    expect(res.json().data.checked_booths[0].display_code).toBe(null)
    await app.close()
  })
})

describe('参加者 POST /events/:id/awards/vote', () => {
  it('is_open=false のとき 409 VOTING_CLOSED（T-2）', async () => {
    const app = await buildApp(makeDb(participantHandler({ isOpen: 0 })))
    const res = await app.inject({
      method: 'POST', url: `/api/v1/events/${EVENT_ID}/awards/vote`, headers: auth('participant'),
      payload: { votes: { [AWARD_ID]: BOOTH_OK } },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('VOTING_CLOSED')
    await app.close()
  })

  it('チェックインしていないブースへ直接 POST すると 403 NOT_CHECKED_IN（T-3 / T-8）', async () => {
    const app = await buildApp(makeDb(participantHandler({ isOpen: 1, checkedBoothId: BOOTH_OK })))
    const res = await app.inject({
      method: 'POST', url: `/api/v1/events/${EVENT_ID}/awards/vote`, headers: auth('participant'),
      payload: { votes: { [AWARD_ID]: BOOTH_NG } },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('NOT_CHECKED_IN')
    await app.close()
  })

  it('他イベントの award_id は 404（T-7）', async () => {
    const app = await buildApp(makeDb(participantHandler({ isOpen: 1, checkedBoothId: BOOTH_OK, awardIds: [] })))
    const res = await app.inject({
      method: 'POST', url: `/api/v1/events/${EVENT_ID}/awards/vote`, headers: auth('participant'),
      payload: { votes: { [AWARD_ID]: BOOTH_OK } },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('チェックイン済みブースへの投票は上書き INSERT を発行する（T-4 / T-5）', async () => {
    const calls: Call[] = []
    const app = await buildApp(makeDb(participantHandler({ isOpen: 1, checkedBoothId: BOOTH_OK }), calls))
    const res = await app.inject({
      method: 'POST', url: `/api/v1/events/${EVENT_ID}/awards/vote`, headers: auth('participant'),
      payload: { votes: { [AWARD_ID]: BOOTH_OK } },
    })
    expect(res.statusCode).toBe(200)
    const ins = calls.find((c) => /INSERT INTO award_votes/.test(c.sql))!
    expect(ins.sql).toMatch(/ON DUPLICATE KEY UPDATE booth_id = VALUES\(booth_id\)/)
    await app.close()
  })

  it('booth_id: null で取り消し（DELETE を発行）（T-6）', async () => {
    const calls: Call[] = []
    const app = await buildApp(makeDb(participantHandler({ isOpen: 1, checkedBoothId: BOOTH_OK }), calls))
    const res = await app.inject({
      method: 'POST', url: `/api/v1/events/${EVENT_ID}/awards/vote`, headers: auth('participant'),
      payload: { votes: { [AWARD_ID]: null } },
    })
    expect(res.statusCode).toBe(200)
    expect(calls.some((c) => /DELETE FROM award_votes/.test(c.sql))).toBe(true)
    await app.close()
  })

  it('1件でも不正なら何も保存しない（部分適用しない）', async () => {
    const calls: Call[] = []
    const app = await buildApp(makeDb(participantHandler({ isOpen: 1, checkedBoothId: BOOTH_OK }), calls))
    await app.inject({
      method: 'POST', url: `/api/v1/events/${EVENT_ID}/awards/vote`, headers: auth('participant'),
      payload: { votes: { [AWARD_ID]: BOOTH_OK, [BOOTH_NG]: BOOTH_NG } }, // 2件目の award_id が不正
    })
    expect(calls.some((c) => /INSERT INTO award_votes|DELETE FROM award_votes/.test(c.sql))).toBe(false)
    await app.close()
  })
})

describe('運営 API の認可（issue #124）', () => {
  const adminHandler = (sql: string) => {
    if (/FROM award_settings/.test(sql)) return [{ is_open: 0 }]
    if (/FROM awards a/.test(sql)) return []
    if (/SELECT id, name FROM awards WHERE id = \?/.test(sql)) return [{ id: AWARD_ID, name: '賞' }]
    if (/FROM award_votes v/.test(sql)) return []
    return []
  }

  it('viewer は一覧・集計を見られる（T-10 前半）', async () => {
    const app = await buildApp(makeDb(adminHandler))
    const list = await app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/awards`, headers: auth('viewer') })
    expect(list.statusCode).toBe(200)
    const tally = await app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/awards/${AWARD_ID}/tally`, headers: auth('viewer') })
    expect(tally.statusCode).toBe(200)
    await app.close()
  })

  it('viewer は開閉・CRUD が 403（T-10 後半）', async () => {
    const app = await buildApp(makeDb(adminHandler))
    for (const [method, url, payload] of [
      ['PATCH', `/api/v1/admin/events/${EVENT_ID}/awards/voting`, { is_open: true }],
      ['POST', `/api/v1/admin/events/${EVENT_ID}/awards`, { name: 'x' }],
      ['DELETE', `/api/v1/admin/events/${EVENT_ID}/awards/${AWARD_ID}`, undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth('viewer'), payload })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    await app.close()
  })

  it('participant は /admin/* に到達できない（T-11）', async () => {
    const app = await buildApp(makeDb(adminHandler))
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/awards`, headers: auth('participant') })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('tally / 一覧の集計 SQL が role=participant で絞っている（T-9）', async () => {
    const calls: Call[] = []
    const app = await buildApp(makeDb(adminHandler, calls))
    await app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/awards/${AWARD_ID}/tally`, headers: auth('manager') })
    const tallySql = calls.find((c) => /FROM award_votes v/.test(c.sql))!
    expect(tallySql.sql).toMatch(/u\.role = 'participant'/)
    await app.close()
  })

  it('開閉は manager が実行でき 200・監査ログを残す', async () => {
    const calls: Call[] = []
    const app = await buildApp(makeDb((sql) => {
      if (/FROM award_settings/.test(sql)) return [{ is_open: 1 }]
      return []
    }, calls))
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/events/${EVENT_ID}/awards/voting`, headers: auth('manager'),
      payload: { is_open: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.is_open).toBe(true)
    expect(calls.some((c) => /INSERT INTO audit_logs/.test(c.sql) && JSON.stringify(c.params).includes('award.voting.update'))).toBe(true)
    await app.close()
  })
})
