import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../src/db/client.js'
import { assignCenterCell, isCenterComplete, getAchievedCenterPositions } from '../../src/lib/bingo/assignCenterCell.js'

type Cell = { id: string; position: number; zone: 'CENTER' | 'OUTER'; booth_id: string | null; is_achieved: boolean }

/** bingo_cells に限定した最小のインメモリ DbClient。 */
function makeCellsDb(cells: Cell[]): DbClient {
  const query = async (sql: string) => {
    if (/SELECT id, position FROM bingo_cells\s+WHERE card_id = \? AND zone = 'CENTER' AND booth_id IS NULL/.test(sql)) {
      const rows = cells
        .filter((c) => c.zone === 'CENTER' && c.booth_id === null)
        .sort((a, b) => a.position - b.position)
        .slice(0, 1)
        .map((c) => ({ id: c.id, position: c.position }))
      return [rows, undefined] as [unknown, unknown]
    }
    if (/SELECT COUNT\(\*\) AS c FROM bingo_cells WHERE card_id = \? AND zone = 'CENTER' AND is_achieved = 0/.test(sql)) {
      const remaining = cells.filter((c) => c.zone === 'CENTER' && !c.is_achieved).length
      return [[{ c: remaining }], undefined] as [unknown, unknown]
    }
    if (/SELECT position FROM bingo_cells WHERE card_id = \? AND zone = 'CENTER' AND is_achieved = 1/.test(sql)) {
      const rows = cells.filter((c) => c.zone === 'CENTER' && c.is_achieved).map((c) => ({ position: c.position }))
      return [rows, undefined] as [unknown, unknown]
    }
    throw new Error(`unmatched SQL: ${sql}`)
  }
  const execute = async (sql: string, params: unknown[] = []) => {
    if (/UPDATE bingo_cells/.test(sql)) {
      const [, , , cellId] = params as [string, string, string, string]
      const cell = cells.find((c) => c.id === cellId)
      if (cell && cell.booth_id === null) {
        cell.booth_id = 'assigned'
        cell.is_achieved = true
        return [{ affectedRows: 1 }, undefined] as [unknown, unknown]
      }
      return [{ affectedRows: 0 }, undefined] as [unknown, unknown]
    }
    throw new Error(`unmatched SQL: ${sql}`)
  }
  return { query, execute, end: async () => {} }
}

describe('assignCenterCell', () => {
  it('position 昇順で空きの中央マスを1つ割り当てる', async () => {
    const cells: Cell[] = [
      { id: 'c5', position: 5, zone: 'CENTER', booth_id: 'presurvey-booth', is_achieved: false },
      { id: 'c6', position: 6, zone: 'CENTER', booth_id: null, is_achieved: false },
      { id: 'c9', position: 9, zone: 'CENTER', booth_id: null, is_achieved: false },
      { id: 'c10', position: 10, zone: 'CENTER', booth_id: null, is_achieved: false },
    ]
    const db = makeCellsDb(cells)
    const result = await assignCenterCell(db, 'card-1', 'booth-1')
    expect(result).toEqual({ cellId: 'c6', position: 6 })
    expect(cells.find((c) => c.id === 'c6')!.is_achieved).toBe(true)
  })

  it('空きの中央マスが無ければ null を返す（実質すでに中央完成）', async () => {
    const cells: Cell[] = [
      { id: 'c5', position: 5, zone: 'CENTER', booth_id: 'b5', is_achieved: true },
      { id: 'c6', position: 6, zone: 'CENTER', booth_id: 'b6', is_achieved: true },
      { id: 'c9', position: 9, zone: 'CENTER', booth_id: 'b9', is_achieved: true },
      { id: 'c10', position: 10, zone: 'CENTER', booth_id: 'b10', is_achieved: true },
    ]
    const db = makeCellsDb(cells)
    const result = await assignCenterCell(db, 'card-1', 'booth-1')
    expect(result).toBeNull()
  })
})

describe('isCenterComplete', () => {
  it('中央4マスが全て達成済みなら true', async () => {
    const cells: Cell[] = [
      { id: 'c5', position: 5, zone: 'CENTER', booth_id: 'b5', is_achieved: true },
      { id: 'c6', position: 6, zone: 'CENTER', booth_id: 'b6', is_achieved: true },
      { id: 'c9', position: 9, zone: 'CENTER', booth_id: 'b9', is_achieved: true },
      { id: 'c10', position: 10, zone: 'CENTER', booth_id: 'b10', is_achieved: true },
    ]
    const db = makeCellsDb(cells)
    expect(await isCenterComplete(db, 'card-1')).toBe(true)
  })

  it('1マスでも未達成なら false', async () => {
    const cells: Cell[] = [
      { id: 'c5', position: 5, zone: 'CENTER', booth_id: 'b5', is_achieved: true },
      { id: 'c6', position: 6, zone: 'CENTER', booth_id: null, is_achieved: false },
      { id: 'c9', position: 9, zone: 'CENTER', booth_id: 'b9', is_achieved: true },
      { id: 'c10', position: 10, zone: 'CENTER', booth_id: 'b10', is_achieved: true },
    ]
    const db = makeCellsDb(cells)
    expect(await isCenterComplete(db, 'card-1')).toBe(false)
  })
})

describe('getAchievedCenterPositions', () => {
  it('達成済みの中央 position の集合を返す', async () => {
    const cells: Cell[] = [
      { id: 'c5', position: 5, zone: 'CENTER', booth_id: 'b5', is_achieved: true },
      { id: 'c6', position: 6, zone: 'CENTER', booth_id: null, is_achieved: false },
      { id: 'c9', position: 9, zone: 'CENTER', booth_id: 'b9', is_achieved: true },
      { id: 'c10', position: 10, zone: 'CENTER', booth_id: null, is_achieved: false },
    ]
    const db = makeCellsDb(cells)
    const result = await getAchievedCenterPositions(db, 'card-1')
    expect(result).toEqual(new Set([5, 9]))
  })
})
