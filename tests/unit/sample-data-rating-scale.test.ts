import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../src/db/client.js'
import { generateSampleData } from '../../src/lib/sample-data/generate.js'

const EVENT_ID = '20000000-0000-4000-8000-000000000001'

type Call = { sql: string; params: unknown[] }

/**
 * generateSampleData 用の DbClient モック。SELECT は生成処理に必要な最小限の値を返し、
 * INSERT（bulkInsert 経由の execute）はすべて calls に記録して素通しする
 * （sample-data-clear.test.ts と同じ流儀）。
 */
function makeDb(): { db: DbClient; calls: Call[] } {
  const calls: Call[] = []
  const run = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    calls.push({ sql, params })
    if (/FROM events WHERE id/.test(sql)) return [[{ id: EVENT_ID }], undefined]
    if (/SELECT COUNT\(\*\) AS c FROM booths/.test(sql)) return [[{ c: 0 }], undefined]
    if (/information_schema\.tables/.test(sql)) return [[{ c: 0 }], undefined]
    if (/SELECT question_key FROM survey_questions/.test(sql)) return [[], undefined]
    return [{}, undefined]
  }
  return { db: { query: run, execute: run, end: async () => {} }, calls }
}

const RATING_INSERT_COLUMNS = 7 // id, user_id, booth_id, event_id, checkin_id, rating, scale

/** INSERT INTO booth_ratings の全チャンクを rating/scale 単位の行に分解する。 */
function ratingRowsFromCalls(calls: Call[]): { rating: number; scale: number }[] {
  const rows: { rating: number; scale: number }[] = []
  for (const c of calls) {
    if (!/INSERT INTO booth_ratings/.test(c.sql)) continue
    for (let i = 0; i < c.params.length; i += RATING_INSERT_COLUMNS) {
      rows.push({
        rating: c.params[i + 5] as number,
        scale: c.params[i + 6] as number,
      })
    }
  }
  return rows
}

describe('generateSampleData の評価サンプル（NG-15: 元は randomInt(3, 5) 固定で段階数を超えていた）', () => {
  it('rating は指定した ratingScale を超えない', async () => {
    const { db, calls } = makeDb()
    const result = await generateSampleData(db, EVENT_ID, { ratingScale: 4 })

    const ratingRows = ratingRowsFromCalls(calls)
    // 40人 x 最大8ブース x 75%の確率で評価ありのため、実行のたびに0件になることはない
    expect(ratingRows.length).toBeGreaterThan(0)
    expect(result.ratings).toBe(ratingRows.length)
    for (const row of ratingRows) {
      expect(row.rating).toBeGreaterThanOrEqual(1)
      expect(row.rating).toBeLessThanOrEqual(4)
      expect(row.scale).toBe(4)
    }
  })

  it('ratingScale 未指定時は既定の4を使う（config RATING_SCALE の既定値と一致）', async () => {
    const { db, calls } = makeDb()
    await generateSampleData(db, EVENT_ID, {})

    const ratingRows = ratingRowsFromCalls(calls)
    expect(ratingRows.length).toBeGreaterThan(0)
    for (const row of ratingRows) {
      expect(row.rating).toBeLessThanOrEqual(4)
      expect(row.scale).toBe(4)
    }
  })

  it('ratingScale=3 を渡すと3を超える rating も scale も生成しない', async () => {
    const { db, calls } = makeDb()
    await generateSampleData(db, EVENT_ID, { ratingScale: 3 })

    const ratingRows = ratingRowsFromCalls(calls)
    expect(ratingRows.length).toBeGreaterThan(0)
    for (const row of ratingRows) {
      expect(row.rating).toBeGreaterThanOrEqual(1)
      expect(row.rating).toBeLessThanOrEqual(3)
      expect(row.scale).toBe(3)
    }
  })

  it('INSERT に scale 列を含める（列を省くと DB 側の DEFAULT 5 に落ちて既定4と食い違う）', async () => {
    const { db, calls } = makeDb()
    await generateSampleData(db, EVENT_ID, { ratingScale: 4 })

    const insertCalls = calls.filter((c) => /INSERT INTO booth_ratings/.test(c.sql))
    expect(insertCalls.length).toBeGreaterThan(0)
    for (const c of insertCalls) {
      expect(c.sql).toContain('scale')
    }
  })
})
