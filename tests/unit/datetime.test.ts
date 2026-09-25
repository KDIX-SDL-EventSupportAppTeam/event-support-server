import { describe, expect, it } from 'vitest'
import { dateToMysqlUtc, isoToMysqlUtc, toDisplayTimeSlot, toDisplayTzSql, utcMysqlNow } from '../../src/lib/datetime.js'

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

describe('toDisplayTzSql', () => {
  it('wraps the column in CONVERT_TZ from UTC to the display offset (+09:00)', () => {
    expect(toDisplayTzSql('checked_in_at')).toBe("CONVERT_TZ(checked_in_at, '+00:00', '+09:00')")
  })
})

describe('toDisplayTimeSlot', () => {
  it('converts a UTC ISO datetime to a JST 10-minute slot label', () => {
    // 06:21 UTC = 15:21 JST → 15:20 の枠（手動 E2E NG-11: 06:00 に出ていた）
    expect(toDisplayTimeSlot('2026-09-25T06:21:10Z')).toBe('15:20')
  })

  it('wraps past midnight when the JST time is on the next day', () => {
    expect(toDisplayTimeSlot('2026-09-25T16:05:00Z')).toBe('01:00')
  })

  it('supports an hourly step', () => {
    expect(toDisplayTimeSlot('2026-09-25T06:21:10Z', 60)).toBe('15:00')
  })
})
