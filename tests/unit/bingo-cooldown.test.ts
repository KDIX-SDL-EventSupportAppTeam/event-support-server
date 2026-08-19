import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../src/db/client.js'
import { checkCooldown } from '../../src/lib/bingo/cooldown.js'
import { utcMysqlNow } from '../../src/lib/datetime.js'

function makeDb(lastCheckedInAt: string | null, queryLog: string[] = []): DbClient {
  const run = async (sql: string) => {
    queryLog.push(sql)
    return [lastCheckedInAt ? [{ checked_in_at: lastCheckedInAt }] : [], undefined] as [unknown, unknown]
  }
  return { query: run, execute: run, end: async () => {} }
}

describe('checkCooldown', () => {
  it('CHECKIN_COOLDOWN_SEC=0（既定）では DB へ問い合わせず即許可する', async () => {
    const log: string[] = []
    const db = makeDb(null, log)
    const result = await checkCooldown(db, 0, 'u1', 'e1')
    expect(result).toEqual({ blocked: false, remainingSec: 0 })
    expect(log).toHaveLength(0)
  })

  it('直前チェックインが無ければ許可する', async () => {
    const db = makeDb(null)
    const result = await checkCooldown(db, 60, 'u1', 'e1')
    expect(result.blocked).toBe(false)
  })

  it('直前チェックインが古ければ許可する', async () => {
    const old = new Date(Date.now() - 120_000)
    const db = makeDb(old.toISOString().slice(0, 19).replace('T', ' '))
    const result = await checkCooldown(db, 60, 'u1', 'e1')
    expect(result.blocked).toBe(false)
  })

  it('クールタイム内なら拒否し、残り秒数を切り上げて返す', async () => {
    const recent = new Date(Date.now() - 5_000) // 5秒前
    const db = makeDb(recent.toISOString().slice(0, 19).replace('T', ' '))
    const result = await checkCooldown(db, 60, 'u1', 'e1')
    expect(result.blocked).toBe(true)
    expect(result.remainingSec).toBeGreaterThanOrEqual(54)
    expect(result.remainingSec).toBeLessThanOrEqual(56)
  })

  it('サーバー現在時刻との差で判定する（utcMysqlNow相当のちょうど今なら残り≒cooldownSec）', async () => {
    const db = makeDb(utcMysqlNow())
    const result = await checkCooldown(db, 30, 'u1', 'e1')
    expect(result.blocked).toBe(true)
    expect(result.remainingSec).toBeLessThanOrEqual(30)
  })
})
