import type { DbClient } from './client.js'

/**
 * さくらプロキシは PDO のエミュレートモードで動いており、INT / TINYINT も含めて
 * すべての値を文字列で返す（`position: "5"`、`is_achieved: "0"`）。
 * routes は mysql2 と同じく数値が返る前提で `===` / `Set.has` / `Boolean()` を使っているため、
 * そのままだとマスの位置が一致せず、`Boolean("0")` が true になる。
 *
 * ここでは SELECT の結果を「数値であるべき列」だけ数値に直す。判定に使うのは
 * 1. 列名（db/create-tables.sql で数値型の列。テーブル間で同名・別型の列は無い）
 * 2. SQL 中の `<式> AS 別名`（COUNT / SUM / AVG / EXISTS、数値列への MAX / MIN / COALESCE、
 *    数値リテラル、THEN / ELSE が数値だけの CASE）
 * それ以外（ID・メール・display_code・qr_token・日時・JSON）は文字列のまま渡す。
 * 既に数値の値はそのまま通すので、プロキシ側が型付きで返すようになっても害はない。
 */

/** db/create-tables.sql で数値型（INT / TINYINT / SMALLINT / BOOLEAN / DOUBLE）の列。 */
export const NUMERIC_COLUMNS: ReadonlySet<string> = new Set([
  'bonus_coins',
  'coin_index',
  'coins_per_line',
  'decision_table_size',
  'display_order',
  'global_checkin_count',
  'is_achieved',
  'is_active',
  'is_enabled',
  'is_hidden',
  'is_open',
  'is_required',
  'is_revealed',
  'line_index',
  'max_coins',
  'position',
  'rank_in_event',
  'rating',
  'scale',
  'score',
  'sort_order',
  'visit_order',
  'was_assigned',
])

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/

/** 先頭がこれらの関数なら常に数値 */
const ALWAYS_NUMERIC_FN = /^(COUNT|SUM|AVG|EXISTS)\s*\(/i
/** 先頭がこれらの関数なら、第1引数が数値のときだけ数値 */
const PASSTHROUGH_FN = /^(MAX|MIN|COALESCE|IFNULL|ROUND|ABS|GREATEST|LEAST)\s*\(/i

/** `AS alias` の直前にある式を、select リスト上の区切り（, / SELECT / 開き括弧）まで遡って切り出す */
function expressionBefore(sql: string, asIndex: number): string {
  let depth = 0
  let inQuote = false
  for (let i = asIndex - 1; i >= 0; i--) {
    const ch = sql[i]
    if (ch === "'") inQuote = !inQuote
    if (inQuote) continue
    if (ch === ')') depth++
    else if (ch === '(') {
      if (depth === 0) return sql.slice(i + 1, asIndex)
      depth--
    } else if (depth === 0) {
      if (ch === ',') return sql.slice(i + 1, asIndex)
      if (/\s/.test(ch) && /\bSELECT(\s+DISTINCT)?$/i.test(sql.slice(0, i))) return sql.slice(i, asIndex)
    }
  }
  return sql.slice(0, asIndex)
}

/** 括弧の対応を見て、`FN(` 直後の第1引数を取り出す */
function firstArgument(expr: string): string {
  const open = expr.indexOf('(')
  let depth = 0
  for (let i = open + 1; i < expr.length; i++) {
    const ch = expr[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) return expr.slice(open + 1, i)
      depth--
    } else if (ch === ',' && depth === 0) return expr.slice(open + 1, i)
  }
  return expr.slice(open + 1)
}

/** 式の評価結果が数値になるか */
export function isNumericExpression(raw: string): boolean {
  let expr = raw.trim()
  // 外側の括弧を剥がす（スカラーサブクエリ `(SELECT COUNT(*) FROM ...)` を含む）
  while (expr.startsWith('(') && expr.endsWith(')')) expr = expr.slice(1, -1).trim()

  const sub = /^SELECT\s+(DISTINCT\s+)?/i.exec(expr)
  if (sub) {
    const rest = expr.slice(sub[0].length)
    const from = rest.search(/\sFROM\s/i)
    return isNumericExpression(from === -1 ? rest : rest.slice(0, from))
  }
  if (ALWAYS_NUMERIC_FN.test(expr)) return true
  if (PASSTHROUGH_FN.test(expr)) return isNumericExpression(firstArgument(expr))
  if (/^CASE\b/i.test(expr)) {
    const results = [...expr.matchAll(/\b(?:THEN|ELSE)\s+([^\s]+)/gi)].map((m) => m[1])
    return results.length > 0 && results.every((r) => NUMERIC_STRING.test(r))
  }
  if (NUMERIC_STRING.test(expr)) return true
  const column = /^(?:`?\w+`?\.)?`?(\w+)`?$/.exec(expr)
  return column ? NUMERIC_COLUMNS.has(column[1]) : false
}

const aliasCache = new Map<string, ReadonlySet<string>>()

/** SQL 中の `<式> AS 別名` のうち、式が数値になる別名の集合（SQL 文字列ごとにキャッシュ） */
export function numericAliases(sql: string): ReadonlySet<string> {
  const cached = aliasCache.get(sql)
  if (cached) return cached
  const out = new Set<string>()
  for (const m of sql.matchAll(/\bAS\s+`?(\w+)`?/gi)) {
    if (isNumericExpression(expressionBefore(sql, m.index))) out.add(m[1])
  }
  if (aliasCache.size > 1000) aliasCache.clear()
  aliasCache.set(sql, out)
  return out
}

export function coerceRows(sql: string, rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows
  const aliases = numericAliases(sql)
  return rows.map((row) => {
    if (row === null || typeof row !== 'object') return row
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      const numeric = NUMERIC_COLUMNS.has(key) || aliases.has(key)
      out[key] = numeric && typeof value === 'string' && NUMERIC_STRING.test(value) ? Number(value) : value
    }
    return out
  })
}

/** SELECT の結果行を数値型に揃えるアダプター（さくらプロキシ経路でのみ使う） */
export function withTypeCoercion(db: DbClient): DbClient {
  return {
    ...db,
    async query(sql, params) {
      const [rows, fields] = await db.query(sql, params)
      return [coerceRows(sql, rows), fields]
    },
  }
}
