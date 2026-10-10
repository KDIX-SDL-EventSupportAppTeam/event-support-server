/**
 * 対象: src/lib/error-handler.ts（app.ts の setErrorHandler）
 * 仕様: issue #174
 */
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { globalErrorHandler } from '../../src/lib/error-handler.js'
import { sendOk } from '../../src/lib/response.js'

async function build(bodyLimit?: number) {
  const lines: { level: number; msg?: string }[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l))
      cb()
    },
  })
  const app = Fastify({ logger: { level: 'info', stream }, ...(bodyLimit ? { bodyLimit } : {}) })
  app.setErrorHandler(globalErrorHandler)
  app.post('/echo', async (req, reply) => sendOk(reply, req.body))
  app.get('/boom', async () => {
    throw new Error('DB connection secret detail')
  })
  app.get('/teapot', async () => {
    const e = new Error('custom') as Error & { statusCode: number }
    e.statusCode = 418
    throw e
  })
  await app.ready()
  return { app, lines }
}

const WARN = 40
const ERROR = 50

describe('グローバルエラーハンドラー（#174）', () => {
  it('不正な JSON は 400 BAD_REQUEST（500 にしない）。ログは warn で error は無い', async () => {
    const { app, lines } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    })
    await app.close()
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      success: false,
      error: { code: 'BAD_REQUEST', message: expect.any(String) },
    })
    expect(lines.some((l) => l.level === WARN)).toBe(true)
    expect(lines.some((l) => l.level >= ERROR)).toBe(false)
  })

  it('本文サイズ超過は 413 PAYLOAD_TOO_LARGE', async () => {
    const { app } = await build(10)
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'x'.repeat(100) }),
    })
    await app.close()
    expect(res.statusCode).toBe(413)
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('未対応の Content-Type は 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    })
    await app.close()
    expect(res.statusCode).toBe(415)
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('例外を投げるルートは 500 INTERNAL_ERROR。内部メッセージは漏らさず、ログは error', async () => {
    const { app, lines } = await build()
    const res = await app.inject({ method: 'GET', url: '/boom' })
    await app.close()
    expect(res.statusCode).toBe(500)
    expect(res.json().error.code).toBe('INTERNAL_ERROR')
    expect(res.body).not.toContain('secret detail')
    expect(lines.some((l) => l.level === ERROR)).toBe(true)
  })

  it('対応表に無い 4xx も 4xx のまま返す（500 に潰さない）', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/teapot' })
    await app.close()
    expect(res.statusCode).toBe(418)
    expect(res.json().success).toBe(false)
  })

  it('正常系は影響を受けない', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { a: 1 } })
    await app.close()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true, data: { a: 1 } })
  })
})
