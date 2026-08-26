import { describe, expect, it } from 'vitest'
import { resolveEffectiveAccess, buildDefaultAccessDefaults, type AppAccessRow } from '../../src/lib/app-access.js'

const EVENT_ID = '11111111-1111-4111-8111-111111111111'

function row(partial: Partial<AppAccessRow>): AppAccessRow {
  return {
    event_id: EVENT_ID,
    mode: 'closed',
    app_opens_at: null,
    app_closes_at: null,
    pre_survey_closes_at: null,
    updated_by: null,
    updated_at: '2026-08-01 00:00:00',
    ...partial,
  }
}

describe('resolveEffectiveAccess', () => {
  it('行が無いイベントは closed 扱いになる', () => {
    const r = resolveEffectiveAccess(null)
    expect(r.is_open).toBe(false)
    expect(r.mode).toBe('closed')
  })

  it('mode=open は常に is_open true', () => {
    const r = resolveEffectiveAccess(row({ mode: 'open' }))
    expect(r.is_open).toBe(true)
  })

  it('mode=closed は常に is_open false', () => {
    const r = resolveEffectiveAccess(row({ mode: 'closed', app_opens_at: '2000-01-01 00:00:00' }))
    expect(r.is_open).toBe(false)
  })

  describe('mode=scheduled の時刻境界', () => {
    const opensAt = '2026-10-16 00:30:00' // UTC

    it('app_opens_at の1秒前は closed', () => {
      const now = new Date('2026-10-16T00:29:59Z')
      const r = resolveEffectiveAccess(row({ mode: 'scheduled', app_opens_at: opensAt }), now)
      expect(r.is_open).toBe(false)
    })

    it('app_opens_at と同時刻は open', () => {
      const now = new Date('2026-10-16T00:30:00Z')
      const r = resolveEffectiveAccess(row({ mode: 'scheduled', app_opens_at: opensAt }), now)
      expect(r.is_open).toBe(true)
    })

    it('app_opens_at の1秒後は open', () => {
      const now = new Date('2026-10-16T00:30:01Z')
      const r = resolveEffectiveAccess(row({ mode: 'scheduled', app_opens_at: opensAt }), now)
      expect(r.is_open).toBe(true)
    })

    it('app_opens_at が null なら常に closed', () => {
      const r = resolveEffectiveAccess(row({ mode: 'scheduled', app_opens_at: null }))
      expect(r.is_open).toBe(false)
    })

    it('app_closes_at ありで、閉鎖時刻以降は closed になる', () => {
      const closesAt = '2026-10-16 08:00:00'
      const before = resolveEffectiveAccess(
        row({ mode: 'scheduled', app_opens_at: opensAt, app_closes_at: closesAt }),
        new Date('2026-10-16T07:59:59Z'),
      )
      expect(before.is_open).toBe(true)

      const atClose = resolveEffectiveAccess(
        row({ mode: 'scheduled', app_opens_at: opensAt, app_closes_at: closesAt }),
        new Date('2026-10-16T08:00:00Z'),
      )
      expect(atClose.is_open).toBe(false)
    })

    it('app_closes_at なしなら閉じない', () => {
      const r = resolveEffectiveAccess(
        row({ mode: 'scheduled', app_opens_at: opensAt, app_closes_at: null }),
        new Date('2030-01-01T00:00:00Z'),
      )
      expect(r.is_open).toBe(true)
    })
  })

  it('server_time が含まれる', () => {
    const r = resolveEffectiveAccess(null, new Date('2026-01-01T00:00:00Z'))
    expect(r.server_time).toBe('2026-01-01T00:00:00.000Z')
  })

  describe('is_pre_survey_open', () => {
    it('pre_survey_closes_at より前なら true', () => {
      const r = resolveEffectiveAccess(
        row({ pre_survey_closes_at: '2026-10-15 14:59:59' }),
        new Date('2026-10-15T14:59:58Z'),
      )
      expect(r.is_pre_survey_open).toBe(true)
    })

    it('pre_survey_closes_at 以降は false', () => {
      const r = resolveEffectiveAccess(
        row({ pre_survey_closes_at: '2026-10-15 14:59:59' }),
        new Date('2026-10-15T14:59:59Z'),
      )
      expect(r.is_pre_survey_open).toBe(false)
    })

    it('pre_survey_closes_at が null なら常に true', () => {
      const r = resolveEffectiveAccess(row({ pre_survey_closes_at: null }))
      expect(r.is_pre_survey_open).toBe(true)
    })
  })
})

describe('buildDefaultAccessDefaults', () => {
  it('app_opens_at は date_start の30分前', () => {
    const d = buildDefaultAccessDefaults('2026-10-16 01:00:00')
    expect(d.app_opens_at).toBe('2026-10-16 00:30:00')
  })

  it('mode は scheduled', () => {
    const d = buildDefaultAccessDefaults('2026-10-16 01:00:00')
    expect(d.mode).toBe('scheduled')
  })

  it('pre_survey_closes_at は開催日前日23:59:59（JST基準）をUTCで保存する', () => {
    // date_start = 2026-10-16 10:00 UTC = 2026-10-16 19:00 JST
    // 前日23:59:59 JST = 2026-10-15 23:59:59 JST = 2026-10-15 14:59:59 UTC
    const d = buildDefaultAccessDefaults('2026-10-16 10:00:00')
    expect(d.pre_survey_closes_at).toBe('2026-10-15 14:59:59')
  })

  it('JST の日付境界をまたぐケース（date_start が UTC 深夜=JST早朝）', () => {
    // date_start = 2026-10-16 00:00 UTC = 2026-10-16 09:00 JST
    // 前日23:59:59 JST = 2026-10-15 14:59:59 UTC
    const d = buildDefaultAccessDefaults('2026-10-16 00:00:00')
    expect(d.pre_survey_closes_at).toBe('2026-10-15 14:59:59')
  })
})
