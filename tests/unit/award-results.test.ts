import { describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { adminAwardRoutes } from '../../src/routes/v1/admin/awards.js'
import { rankTopBooths } from '../../src/lib/award/ranking.js'

const JWT_SECRET = 'test-secret'
const EVENT_ID = '20000000-0000-4000-8000-000000000001'
const config = { jwtSecret: JWT_SECRET } as unknown as AppConfig

type Call = { sql: string; params: unknown[] }
function makeDb(h: (sql: string) => unknown[], calls: Call[] = []): DbClient {
  const run = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    return [h(sql), undefined] as [unknown, unknown]
  }
  return { query: run, execute: run, end: async () => {} }
}
async function buildApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(async (v1) => {
    await v1.register(adminAwardRoutes)
  }, { prefix: '/api/v1' })
  await app.ready()
  return app
}
function auth(role: string) {
  return { authorization: `Bearer ${jwt.sign({ sub: `${role}-1`, event_id: EVENT_ID, display_name: 't', role }, JWT_SECRET, { algorithm: 'HS256' })}` }
}
const b = (id: string, votes: number) => ({ booth_id: id, booth_name: id, votes })

describe('rankTopBooths', () => {
  it('同数は同順位（23,23,20 → 1,1,3）', () => {
    expect(rankTopBooths([b('a', 23), b('b', 23), b('c', 20), b('d', 1)]).map((r) => r.rank)).toEqual([1, 1, 3])
  })
  it('3位が同率なら全員返す（3件を超えてよい）', () => {
    expect(rankTopBooths([b('a', 9), b('b', 8), b('c', 5), b('d', 5), b('e', 4)]).map((r) => r.booth_id)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('1位が4組同率なら4組とも1位・それ以下は出さない', () => {
    expect(rankTopBooths([b('a', 3), b('b', 3), b('c', 3), b('d', 3), b('e', 2)]).map((r) => r.rank)).toEqual([1, 1, 1, 1])
  })
  it('0票は入れない・空配列は空', () => {
    expect(rankTopBooths([b('a', 0)])).toEqual([])
    expect(rankTopBooths([])).toEqual([])
  })
})

describe('GET /admin/events/:id/awards/results', () => {
  const handler = (sql: string) => {
    if (/FROM award_settings/.test(sql)) return [{ is_open: 1 }]
    if (/COUNT\(DISTINCT v\.user_id\)/.test(sql)) return [{ c: 3 }]
    if (/FROM users\s+WHERE event_id/.test(sql)) return [{ c: 4 }]
    if (/SELECT a\.id, a\.name, a\.color/.test(sql)) {
      return [{ id: 'A1', name: '賞1', color: 'pink', sort_order: 0 }, { id: 'A2', name: '賞2', color: 'blue', sort_order: 1 }]
    }
    if (/GROUP BY v\.award_id/.test(sql)) {
      return [
        { award_id: 'A1', booth_id: 'x', booth_name: 'X', votes: 2 },
        { award_id: 'A1', booth_id: 'y', booth_name: 'Y', votes: 1 },
      ]
    }
    return []
  }

  it('上位・投票者数・投票率をサーバーで計算して返す', async () => {
    const app = await buildApp(makeDb(handler))
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/awards/results`, headers: auth('viewer') })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.voting_open).toBe(true)
    expect(d.summary).toEqual({ total_participants: 4, voters: 3, voter_rate: 0.75, total_votes: 3, award_count: 2 })
    expect(d.awards[0].top).toEqual([
      { rank: 1, booth_id: 'x', booth_name: 'X', votes: 2, share: 2 / 3 },
      { rank: 2, booth_id: 'y', booth_name: 'Y', votes: 1, share: 1 / 3 },
    ])
    expect(d.awards[0].booths_with_votes).toBe(2)
    // 票が無い賞も一覧に出す
    expect(d.awards[1]).toMatchObject({ id: 'A2', total_votes: 0, top: [] })
    expect(typeof d.generated_at).toBe('string')
    await app.close()
  })

  it('参加者 0 人なら voter_rate は null', async () => {
    const app = await buildApp(makeDb((sql) => (/COUNT/.test(sql) ? [{ c: 0 }] : [])))
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/awards/results`, headers: auth('manager') })
    expect(res.json().data.summary.voter_rate).toBeNull()
    await app.close()
  })

  it('集計 SQL は participant・exhibitor・viewer だけを数える（manager の試し投票を数えない）', async () => {
    const calls: Call[] = []
    const app = await buildApp(makeDb(handler, calls))
    await app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/awards/results`, headers: auth('manager') })
    for (const c of calls.filter((c) => /award_votes|FROM users/.test(c.sql))) {
      expect(c.sql).toMatch(/role IN \('participant', 'exhibitor', 'viewer'\)/)
      expect(c.sql).not.toContain('manager')
    }
    await app.close()
  })

  it('participant は到達できない', async () => {
    const app = await buildApp(makeDb(handler))
    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/events/${EVENT_ID}/awards/results`, headers: auth('participant') })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
