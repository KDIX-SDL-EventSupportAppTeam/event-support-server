import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../src/db/client.js'
import {
  QR_TOKEN_ALPHABET,
  QR_TOKEN_LENGTH,
  generateQrToken,
  generateUniqueQrToken,
  isValidQrToken,
} from '../../src/lib/qr-token.js'

function makeDb(query: DbClient['query']): DbClient {
  return { query, execute: query, end: async () => {} }
}

describe('generateQrToken（issue #155）', () => {
  it('10 文字で、紛らわしい文字（0 O 1 I L U）を含まない', () => {
    for (let i = 0; i < 500; i++) {
      const t = generateQrToken()
      expect(t).toHaveLength(QR_TOKEN_LENGTH)
      expect(t).toMatch(/^[2-9A-HJKMNP-TV-Z]{10}$/)
      expect(t).not.toMatch(/[01OILU]/)
    }
  })

  it('字母は 30 種', () => {
    expect(new Set(QR_TOKEN_ALPHABET).size).toBe(30)
  })

  it('連番にならない', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateQrToken()))
    expect(seen.size).toBe(200)
  })

  it('isValidQrToken は字母と長さを検証する', () => {
    expect(isValidQrToken('A7K3PQ2MXF')).toBe(true)
    expect(isValidQrToken('A7K3PQ2MX')).toBe(false)
    expect(isValidQrToken('A7K3PQ2MXO')).toBe(false)
  })
})

describe('generateUniqueQrToken', () => {
  it('INSERT 前に SELECT で空きを確認し、event_id を条件にしない（グローバル一意）', async () => {
    const calls: { sql: string; params: unknown[] }[] = []
    const db = makeDb(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      return [[], undefined] as [unknown, unknown]
    })
    const t = await generateUniqueQrToken(db)
    expect(t).toHaveLength(10)
    expect(calls[0].sql).toMatch(/FROM booths WHERE qr_token = \?/)
    expect(calls[0].sql).not.toMatch(/event_id/)
  })

  it('衝突したら引き直す', async () => {
    let n = 0
    const db = makeDb(async () => [n++ < 2 ? [{ x: 1 }] : [], undefined] as [unknown, unknown])
    await generateUniqueQrToken(db)
    expect(n).toBe(3)
  })

  it('8 回引き直しても空かなければ例外', async () => {
    const db = makeDb(async () => [[{ x: 1 }], undefined] as [unknown, unknown])
    await expect(generateUniqueQrToken(db)).rejects.toThrow('QR トークン')
  })
})
