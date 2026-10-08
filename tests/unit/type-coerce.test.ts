import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { DbClient } from '../../src/db/client.js'
import {
  NUMERIC_COLUMNS,
  coerceRows,
  isNumericExpression,
  numericAliases,
  withTypeCoercion,
} from '../../src/db/type-coerce.js'

describe('NUMERIC_COLUMNS', () => {
  it('db/create-tables.sql の数値型の列と一致する（スキーマ変更時の追従漏れ検知）', () => {
    const ddl = readFileSync(new URL('../../db/create-tables.sql', import.meta.url), 'utf8')
    const numeric = new Set<string>()
    const other = new Set<string>()
    for (const m of ddl.matchAll(/^\s+([a-z_]+)\s+([A-Z]+)/gm)) {
      if (['PRIMARY', 'UNIQUE', 'FOREIGN', 'INDEX', 'CHECK', 'KEY', 'CONSTRAINT'].includes(m[2])) continue
      ;(/^(INT|TINYINT|SMALLINT|MEDIUMINT|BIGINT|BOOLEAN|BOOL|DOUBLE|FLOAT|DECIMAL)$/.test(m[2]) ? numeric : other).add(
        m[1],
      )
    }
    expect([...NUMERIC_COLUMNS].sort()).toEqual([...numeric].sort())
    // 同名で別型の列があると列名だけでは判定できない
    expect([...numeric].filter((c) => other.has(c))).toEqual([])
  })
})

describe('isNumericExpression', () => {
  it.each([
    ['COUNT(*)'],
    ['COUNT(DISTINCT v.user_id)'],
    ['SUM(CASE WHEN ci.checkin_method = \'qr\' THEN 1 ELSE 0 END)'],
    ['AVG(br.rating)'],
    ['COALESCE(MAX(visit_order),0)'],
    ['MAX(c.position)'],
    ['(SELECT COUNT(*) FROM check_ins ci WHERE ci.booth_id = b.id)'],
    ['(SELECT AVG(rating) FROM booth_ratings br WHERE br.booth_id = b.id)'],
    ['EXISTS(SELECT 1 FROM check_ins ci WHERE ci.user_id = ?)'],
    ['1'],
    ['cell.position'],
    ['c.is_achieved'],
    ['CASE WHEN x THEN 1 ELSE 0 END'],
  ])('%s は数値', (expr) => {
    expect(isNumericExpression(expr)).toBe(true)
  })

  it.each([
    ['MIN(checked_in_at)'],
    ['ci.checkin_method'],
    ['b.display_code'],
    ["DATE_FORMAT(ci.checked_in_at, '%H:00')"],
    ["CASE WHEN x THEN 'a' ELSE 'b' END"],
    ['table_name'],
  ])('%s は数値ではない', (expr) => {
    expect(isNumericExpression(expr)).toBe(false)
  })
})

describe('numericAliases', () => {
  it('select リストの別名を式ごとに判定する', () => {
    const sql = `SELECT b.id AS booth_id, b.name AS booth_name,
        (SELECT COUNT(*) FROM check_ins ci WHERE ci.booth_id = b.id) AS checkin_count,
        SUM(CASE WHEN ci.checkin_method = 'qr' THEN 1 ELSE 0 END) AS qr_count,
        MIN(ci.checked_in_at) AS first_checkin_at,
        DATE_FORMAT(ci.checked_in_at, '%Y-%m-%d %H:00:00') AS hour,
        COALESCE(MAX(visit_order),0) AS m
      FROM booths b`
    expect([...numericAliases(sql)].sort()).toEqual(['checkin_count', 'm', 'qr_count'])
  })

  it('DISTINCT 直後の式も拾う', () => {
    expect([...numericAliases('SELECT DISTINCT COUNT(*) AS c FROM t')]).toEqual(['c'])
  })
})

describe('coerceRows', () => {
  it('数値列と数値の別名だけを数値にし、それ以外は文字列のまま', () => {
    const sql = 'SELECT c.position, c.is_achieved, c.booth_id, b.display_code, COUNT(*) AS c FROM bingo_cells c'
    const rows = coerceRows(sql, [
      { position: '5', is_achieved: '0', booth_id: '1234', display_code: '001', c: '3' },
    ])
    expect(rows).toEqual([{ position: 5, is_achieved: 0, booth_id: '1234', display_code: '001', c: 3 }])
  })

  it('null・既に数値の値・数値でない文字列はそのまま', () => {
    const rows = coerceRows('SELECT rating, score, position FROM t', [{ rating: null, score: 0.5, position: 'x' }])
    expect(rows).toEqual([{ rating: null, score: 0.5, position: 'x' }])
  })

  it('小数・負数も数値にする', () => {
    expect(coerceRows('SELECT score FROM t', [{ score: '-0.25' }])).toEqual([{ score: -0.25 }])
  })
})

describe('withTypeCoercion', () => {
  it('query の結果だけを変換し、execute はそのまま通す', async () => {
    const inner: DbClient = {
      query: async () => [[{ position: '5', is_revealed: '1' }], []],
      execute: async () => [{ affectedRows: 1, insertId: null }, []],
      end: async () => {},
    }
    const db = withTypeCoercion(inner)
    const [rows] = await db.query('SELECT position, is_revealed FROM bingo_cells', [])
    expect(rows).toEqual([{ position: 5, is_revealed: 1 }])
    const [res] = await db.execute('UPDATE t SET a = 1', [])
    expect(res).toEqual({ affectedRows: 1, insertId: null })
    // Boolean("0") が true になる不具合の再現防止
    const [hidden] = await withTypeCoercion({
      ...inner,
      query: async () => [[{ is_hidden: '0' }], []],
    }).query('SELECT is_hidden FROM booth_ratings', [])
    expect(Boolean((hidden as { is_hidden: number }[])[0].is_hidden)).toBe(false)
  })
})
