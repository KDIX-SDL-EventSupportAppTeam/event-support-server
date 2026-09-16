import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../src/db/client.js'
import { clearSampleData } from '../../src/lib/sample-data/clear.js'

const EVENT_ID = 'e1'

type Call = { sql: string; params: unknown[] }

/**
 * SQL をパターン照合して結果を返す DbClient モック。実行順を `calls` に記録する。
 * SELECT は用途ごとに、DML は affectedRows を返す。
 */
function makeDb(opts: {
  userIds?: string[]
  boothIds?: string[]
  categoryIds?: string[]
  hasBoothCategories?: boolean
  clearedCells?: number
}) {
  const calls: Call[] = []
  const userIds = opts.userIds ?? []
  const boothIds = opts.boothIds ?? []
  const categoryIds = opts.categoryIds ?? []

  const run = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    calls.push({ sql, params })
    if (/information_schema\.tables/i.test(sql)) {
      return [[{ c: opts.hasBoothCategories === false ? 0 : 1 }], undefined]
    }
    if (/SELECT id FROM users/.test(sql)) return [userIds.map((id) => ({ id })), undefined]
    if (/SELECT id FROM booths/.test(sql)) return [boothIds.map((id) => ({ id })), undefined]
    if (/SELECT id FROM categories/.test(sql)) return [categoryIds.map((id) => ({ id })), undefined]
    if (/^\s*UPDATE bingo_cells/.test(sql)) {
      return [{ affectedRows: opts.clearedCells ?? 0 }, undefined]
    }
    if (/^\s*DELETE FROM/.test(sql)) return [{ affectedRows: 1 }, undefined]
    throw new Error(`unmatched SQL: ${sql}`)
  }

  const db: DbClient = { query: run, execute: run, end: async () => {} }
  return { db, calls }
}

const sqlList = (calls: Call[]) => calls.map((c) => c.sql)
const indexOfSql = (calls: Call[], re: RegExp) => sqlList(calls).findIndex((s) => re.test(s))

describe('clearSampleData', () => {
  it('サンプルブースを消す前に bingo_cells の割り当てを外す（booth_id は ON DELETE RESTRICT のため）', async () => {
    const { db, calls } = makeDb({ boothIds: ['b1', 'b2'], clearedCells: 3 })
    const result = await clearSampleData(db, EVENT_ID)

    const updateIdx = indexOfSql(calls, /^\s*UPDATE bingo_cells/)
    const deleteBoothIdx = indexOfSql(calls, /^\s*DELETE FROM booths/)
    expect(updateIdx).toBeGreaterThanOrEqual(0)
    expect(deleteBoothIdx).toBeGreaterThanOrEqual(0)
    // 順序が逆だと ER_ROW_IS_REFERENCED で落ちる
    expect(updateIdx).toBeLessThan(deleteBoothIdx)
    expect(result.cleared_cells).toBe(3)
  })

  it('割り当て解除は booth_id を NULL にし、カードやマス自体は消さない', async () => {
    const { db, calls } = makeDb({ boothIds: ['b1'] })
    await clearSampleData(db, EVENT_ID)

    const update = calls.find((c) => /^\s*UPDATE bingo_cells/.test(c.sql))!
    expect(update.sql).toMatch(/booth_id = NULL/)
    expect(update.params).toEqual(['b1'])
    // 起きてはいけないこと: 実参加者のカード・マスを削除してしまう
    expect(sqlList(calls).some((s) => /DELETE FROM bingo_cards/.test(s))).toBe(false)
    expect(sqlList(calls).some((s) => /DELETE FROM bingo_cells/.test(s))).toBe(false)
  })

  it('達成済みフラグと達成時刻も戻す（消えたブースの達成を残さない）', async () => {
    const { db, calls } = makeDb({ boothIds: ['b1'] })
    await clearSampleData(db, EVENT_ID)

    const update = calls.find((c) => /^\s*UPDATE bingo_cells/.test(c.sql))!
    expect(update.sql).toMatch(/is_achieved = 0/)
    expect(update.sql).toMatch(/achieved_at = NULL/)
  })

  it('廃止された recommendations テーブルを触らない', async () => {
    const { db, calls } = makeDb({ userIds: ['u1'], boothIds: ['b1'], categoryIds: ['c1'] })
    await clearSampleData(db, EVENT_ID)

    expect(sqlList(calls).some((s) => /\brecommendations\b/.test(s))).toBe(false)
  })

  it('サンプルブースが無ければ bingo_cells を触らない', async () => {
    const { db, calls } = makeDb({ userIds: ['u1'] })
    const result = await clearSampleData(db, EVENT_ID)

    expect(sqlList(calls).some((s) => /UPDATE bingo_cells/.test(s))).toBe(false)
    expect(result.cleared_cells).toBe(0)
  })

  it('対象が何も無ければ SQL を発行せず 0 件で返す', async () => {
    const { db, calls } = makeDb({})
    const result = await clearSampleData(db, EVENT_ID)

    expect(result).toEqual({
      deleted: { users: 0, booths: 0, categories: 0, survey_questions: 0 },
      cleared_cells: 0,
    })
    expect(sqlList(calls).some((s) => /^\s*(DELETE|UPDATE)/.test(s))).toBe(false)
  })
})
