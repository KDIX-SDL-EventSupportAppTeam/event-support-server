import { describe, expect, it } from 'vitest'
import { isoToMysqlUtc } from './datetime.js'

describe('isoToMysqlUtc', () => {
  it('converts ISO to UTC MySQL datetime', () => {
    expect(isoToMysqlUtc('2026-05-12T10:30:00.000Z')).toBe('2026-05-12 10:30:00')
  })
})
