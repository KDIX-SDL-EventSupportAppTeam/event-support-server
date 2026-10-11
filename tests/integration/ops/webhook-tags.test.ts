/**
 * 対象: src/routes/v1/ops.ts（POST /webhook/booths/sync のタグ処理）
 * 仕様: issue #175 / ADR 0001（本番プロキシはエラーを 500 に潰し、トランザクションも無い）
 *
 * ローカル MySQL（docker compose）に対して実行する。
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig } from '../../../src/config.js'
import type { DbClient } from '../../../src/db/client.js'
import { webhookRoutes } from '../../../src/routes/v1/ops.js'
import { assertDbReachable, cleanupEvent, config, makePool, seedFixture } from '../gacha/helpers.js'

const API_KEY = 'webhook-test-key'
let db: DbClient
const created: { eventId: string; organizerId: string }[] = []

beforeAll(async () => {
  db = makePool()
  await assertDbReachable(db)
})
afterEach(async () => {
  while (created.length) {
    const e = created.pop()!
    await cleanupEvent(db, e.eventId, e.organizerId)
  }
})
afterAll(async () => {
  await db?.end()
})

async function buildApp(client: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', { ...config, webhookApiKey: API_KEY } as AppConfig)
  app.decorate('db', client)
  await app.register(webhookRoutes, { prefix: '/api/v1' })
  await app.ready()
  return app
}

async function sync(app: FastifyInstance, eventId: string, formId: string, tags: unknown) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/webhook/booths/sync',
    headers: { 'x-api-key': API_KEY },
    payload: { event_id: eventId, google_form_response_id: formId, booth: { name: 'ブース', tags } },
  })
  return { status: res.statusCode, body: res.json() }
}

async function tagsOf(boothId: string): Promise<string[]> {
  const [rows] = await db.query(`SELECT tag FROM booth_tags WHERE booth_id = ? ORDER BY tag`, [boothId])
  return (rows as { tag: string }[]).map((r) => r.tag)
}

async function newEvent() {
  const f = await seedFixture(db)
  created.push({ eventId: f.eventId, organizerId: f.organizerId })
  return f.eventId
}

describe('#175 ops Webhook のタグ', () => {
  it('新規: ["AI","AI"] は 200 で 1 件だけ保存される', async () => {
    const eventId = await newEvent()
    const app = await buildApp(db)
    const r = await sync(app, eventId, 'form-1', ['AI', 'AI'])
    await app.close()
    expect(r.status).toBe(200)
    expect(await tagsOf(r.body.data.booth_id)).toEqual(['AI'])
  })

  it('trim・空文字除外・大文字小文字違いの重複除去（先に来た表記を残す）', async () => {
    const eventId = await newEvent()
    const app = await buildApp(db)
    const r = await sync(app, eventId, 'form-1', [' AI ', '', '   ', 'ai', 'IoT'])
    await app.close()
    expect(r.status).toBe(200)
    expect(await tagsOf(r.body.data.booth_id)).toEqual(['AI', 'IoT'])
  })

  it('更新: 重複を含む tags でも 200 で、正しく置き換わる（古いタグは消え、残すタグは残る）', async () => {
    const eventId = await newEvent()
    const app = await buildApp(db)
    const first = await sync(app, eventId, 'form-1', ['AI', 'Web', 'IoT'])
    const boothId = first.body.data.booth_id
    const second = await sync(app, eventId, 'form-1', ['Web', 'Web', 'ロボット'])
    await app.close()
    expect(second.status).toBe(200)
    expect(second.body.data.action).toBe('updated')
    expect(second.body.data.booth_id).toBe(boothId)
    expect(await tagsOf(boothId)).toEqual(['Web', 'ロボット'].sort())
  })

  it('更新: tags が空配列なら全削除', async () => {
    const eventId = await newEvent()
    const app = await buildApp(db)
    const first = await sync(app, eventId, 'form-1', ['AI'])
    const second = await sync(app, eventId, 'form-1', [])
    await app.close()
    expect(second.status).toBe(200)
    expect(await tagsOf(first.body.data.booth_id)).toEqual([])
  })

  it('起きてはいけないこと: 更新中にタグの INSERT が失敗しても、古いタグが消えたままにならない', async () => {
    const eventId = await newEvent()
    const okApp = await buildApp(db)
    const first = await sync(okApp, eventId, 'form-1', ['AI', 'Web'])
    await okApp.close()
    const boothId = first.body.data.booth_id

    // booth_tags への INSERT だけを失敗させる（プロキシが 500 に潰す状況）
    const failing: DbClient = {
      query: (sql, params) => db.query(sql, params),
      execute: (sql, params) => {
        if (/INSERT INTO booth_tags/.test(sql)) return Promise.reject(new Error('Internal Server Error'))
        return db.execute(sql, params)
      },
      end: async () => {},
    }
    const badApp = await buildApp(failing)
    const r = await sync(badApp, eventId, 'form-1', ['Robot'])
    await badApp.close()

    expect(r.status).toBe(500)
    expect(await tagsOf(boothId)).toEqual(['AI', 'Web'])
  })

  it('50 件超・255 文字超は従来どおり 422', async () => {
    const eventId = await newEvent()
    const app = await buildApp(db)
    const tooMany = await sync(app, eventId, 'form-1', Array.from({ length: 51 }, (_, i) => `t${i}`))
    const tooLong = await sync(app, eventId, 'form-2', ['x'.repeat(256)])
    await app.close()
    expect(tooMany.status).toBe(422)
    expect(tooLong.status).toBe(422)
  })
})
