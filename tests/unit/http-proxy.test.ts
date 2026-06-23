import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpProxy } from '../../src/db/http-proxy.js'

/** fetch をモックし、プロキシへ送られた body をキャプチャする */
function mockFetchOnce(): { sentBody: () => { sql: string; params: unknown[] } } {
  let captured = ''
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    captured = init.body
    return {
      ok: true,
      json: async () => ({ rows: [], affectedRows: 1, insertId: null }),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return { sentBody: () => JSON.parse(captured) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createHttpProxy param normalization', () => {
  it('converts boolean params to 0/1 (さくらMySQL は boolean をバインドできない)', async () => {
    const { sentBody } = mockFetchOnce()
    const db = createHttpProxy('https://example.test/proxy', 'key')
    await db.execute('INSERT INTO t (a, b) VALUES (?, ?)', [true, false])
    expect(sentBody().params).toEqual([1, 0])
  })

  it('converts Date params to MySQL DATETIME (ISO 8601 は受け付けられない)', async () => {
    const { sentBody } = mockFetchOnce()
    const db = createHttpProxy('https://example.test/proxy', 'key')
    await db.execute('INSERT INTO t (ts) VALUES (?)', [new Date('2026-06-16T15:30:00.000Z')])
    expect(sentBody().params).toEqual(['2026-06-16 15:30:00'])
  })

  it('leaves strings and numbers untouched', async () => {
    const { sentBody } = mockFetchOnce()
    const db = createHttpProxy('https://example.test/proxy', 'key')
    await db.execute('INSERT INTO t (a, b) VALUES (?, ?)', ['hello', 42])
    expect(sentBody().params).toEqual(['hello', 42])
  })
})
