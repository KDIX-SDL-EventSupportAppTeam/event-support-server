import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../src/db/client.js'
import { assignCenterCell } from '../../src/lib/bingo/assignCenterCell.js'
import { isCenterComplete } from '../../src/lib/bingo/assignCenterCell.js'

type Cell = { id: string; position: number; zone: 'CENTER' | 'OUTER'; state: 'LOCKED' | 'EMPTY' | 'ACHIEVED' }

/** bingo_cells に限定した最小のインメモリ DbClient。 */
function makeCellsDb(cells: Cell[]): DbClient {
  const query = async (sql: string) => {
    if (/SELECT id, position FROM bingo_cells/.test(sql)) {
      const rows = cells
        .filter((c) => c.zone === 'CENTER' && c.state === 'EMPTY')
        .sort((a, b) => a.position - b.position)
        .slice(0, 1)
        .map((c) => ({ id: c.id, position: c.position }))
      return [rows, undefined] as [unknown, unknown]
    }
    if (/SELECT COUNT\(\*\) AS c FROM bingo_cells WHERE card_id = \? AND zone = 'CENTER' AND state <> 'ACHIEVED'/.test(sql)) {
      const remaining = cells.filter((c) => c.zone === 'CENTER' && c.state !== 'ACHIEVED').length
      return [[{ c: remaining }], undefined] as [unknown, unknown]
    }
    throw new Error(`unmatched SQL: ${sql}`)
  }
  const execute = async (sql: string, params: unknown[] = []) => {
    if (/UPDATE bingo_cells/.test(sql)) {
      const [, , , cellId] = params as [string, string, string, string]
      const cell = cells.find((c) => c.id === cellId)
      if (cell && cell.state === 'EMPTY') {
        cell.state = 'ACHIEVED'
        return [{ affectedRows: 1 }, undefined] as [unknown, unknown]
      }
      return [{ affectedRows: 0 }, undefined] as [unknown, unknown]
    }
    throw new Error(`unmatched SQL: ${sql}`)
  }
  return { query, execute, end: async () => {} }
}

describe('assignCenterCell', () => {
  it('position 昇順で EMPTY な中央マスを1つ割り当てる', async () => {
    const cells: Cell[] = [
      { id: 'c5', position: 5, zone: 'CENTER', state: 'ACHIEVED' }, // ボーナス済み
      { id: 'c6', position: 6, zone: 'CENTER', state: 'EMPTY' },
      { id: 'c9', position: 9, zone: 'CENTER', state: 'EMPTY' },
      { id: 'c10', position: 10, zone: 'CENTER', state: 'EMPTY' },
    ]
    const db = makeCellsDb(cells)
    const result = await assignCenterCell(db, 'card-1', 'booth-1')
    expect(result).toEqual({ cellId: 'c6', position: 6 })
    expect(cells.find((c) => c.id === 'c6')!.state).toBe('ACHIEVED')
  })

  it('EMPTY な中央マスが無ければ null を返す（実質すでに中央完成）', async () => {
    const cells: Cell[] = [
      { id: 'c5', position: 5, zone: 'CENTER', state: 'ACHIEVED' },
      { id: 'c6', position: 6, zone: 'CENTER', state: 'ACHIEVED' },
      { id: 'c9', position: 9, zone: 'CENTER', state: 'ACHIEVED' },
      { id: 'c10', position: 10, zone: 'CENTER', state: 'ACHIEVED' },
    ]
    const db = makeCellsDb(cells)
    const result = await assignCenterCell(db, 'card-1', 'booth-1')
    expect(result).toBeNull()
  })
})

describe('isCenterComplete', () => {
  it('中央4マスが全て ACHIEVED なら true', async () => {
    const cells: Cell[] = [
      { id: 'c5', position: 5, zone: 'CENTER', state: 'ACHIEVED' },
      { id: 'c6', position: 6, zone: 'CENTER', state: 'ACHIEVED' },
      { id: 'c9', position: 9, zone: 'CENTER', state: 'ACHIEVED' },
      { id: 'c10', position: 10, zone: 'CENTER', state: 'ACHIEVED' },
    ]
    const db = makeCellsDb(cells)
    expect(await isCenterComplete(db, 'card-1')).toBe(true)
  })

  it('1マスでも未達成なら false', async () => {
    const cells: Cell[] = [
      { id: 'c5', position: 5, zone: 'CENTER', state: 'ACHIEVED' },
      { id: 'c6', position: 6, zone: 'CENTER', state: 'EMPTY' },
      { id: 'c9', position: 9, zone: 'CENTER', state: 'ACHIEVED' },
      { id: 'c10', position: 10, zone: 'CENTER', state: 'ACHIEVED' },
    ]
    const db = makeCellsDb(cells)
    expect(await isCenterComplete(db, 'card-1')).toBe(false)
  })
})
