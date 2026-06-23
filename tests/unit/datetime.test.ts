import { describe, expect, it } from 'vitest'
import { dateToMysqlUtc, isoToMysqlUtc, utcMysqlNow } from '../../src/lib/datetime.js'

describe('isoToMysqlUtc', () => {
  it('converts ISO to UTC MySQL datetime', () => {
    expect(isoToMysqlUtc('2026-05-12T10:30:00.000Z')).toBe('2026-05-12 10:30:00')
  })

  it('throws on invalid datetime', () => {
    expect(() => isoToMysqlUtc('not-a-date')).toThrow()
  })
})

describe('dateToMysqlUtc', () => {
  it('formats a Date as YYYY-MM-DD HH:MM:SS (UTC, no T/Z/ms)', () => {
    expect(dateToMysqlUtc(new Date('2026-05-12T10:30:45.999Z'))).toBe('2026-05-12 10:30:45')
  })
})

describe('utcMysqlNow', () => {
  it('returns a MySQL DATETIME shaped string', () => {
    expect(utcMysqlNow()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})
