/**
 * DB 接続疎通チェック。
 *
 * 用途:
 *   - さくら DB（本番）など、`DATABASE_URL` で指す DB に対して
 *     プロジェクト本体と同じ mysql2 ドライバ・同じ接続経路で繋がるかを確かめる。
 *   - スキーマ DDL を適用済みかどうかを「テーブル数 18」で判定する。
 *   - 主要テーブルの行数を表示し、シード投入の要否を一目でわかるようにする。
 *
 * 使い方:
 *   npm run db:check
 *
 * 期待値:
 *   - tables: 18
 *   - events / survey_questions に最低 1 行（空なら seed が必要）
 */
import 'dotenv/config'
import { loadConfig } from '../config.js'
import { createPool } from '../db/pool.js'

const EXPECTED_TABLES = 18
const EXPECTED_TABLE_NAMES = [
  'organizers',
  'events',
  'categories',
  'booths',
  'booth_tags',
  'users',
  'survey_questions',
  'user_survey_answers',
  'check_ins',
  'booth_ratings',
  'recommendations',
  'booth_categories',
  'exhibitor_booths',
  'email_verification_tokens',
  'audit_logs',
  'bingo_cards',
  'bingo_cells',
  'cell_assignment_logs',
] as const

async function main() {
  const config = loadConfig()
  const safeUrl = config.databaseUrl.replace(/:[^:@/]+@/, ':***@')
  console.log(`[db:check] connecting to ${safeUrl}`)

  const pool = createPool(config)
  try {
    const [pingRows] = await pool.query('SELECT 1 AS ok, DATABASE() AS db, VERSION() AS version')
    const ping = (pingRows as { ok: number; db: string; version: string }[])[0]
    console.log(`[db:check] connected. db=${ping.db} version=${ping.version}`)

    const [tableRows] = await pool.query(
      `SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
       ORDER BY table_name`,
    )
    const tableNames = (tableRows as { name: string }[]).map((r) => r.name)
    console.log(`[db:check] tables (${tableNames.length}):`, tableNames.join(', ') || '(none)')

    const missing = EXPECTED_TABLE_NAMES.filter((t) => !tableNames.includes(t))
    if (missing.length) {
      console.error(`[db:check] NG: missing tables: ${missing.join(', ')}`)
      console.error('[db:check] => db/create-tables.sql を対象 DB で実行してください')
      process.exitCode = 1
    } else if (tableNames.length !== EXPECTED_TABLES) {
      console.warn(
        `[db:check] WARN: expected ${EXPECTED_TABLES} tables, found ${tableNames.length}. ` +
          '想定外のテーブルが含まれている可能性があります。',
      )
    } else {
      console.log(`[db:check] OK: all ${EXPECTED_TABLES} tables exist`)
    }

    for (const t of EXPECTED_TABLE_NAMES) {
      if (!tableNames.includes(t)) continue
      const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM \`${t}\``)
      const n = (rows as { n: number }[])[0]?.n ?? 0
      const hint =
        t === 'events' && n === 0
          ? '  ← 空。`npm run db:seed:prod` で本番イベント行の投入が必要'
          : t === 'survey_questions' && n === 0
            ? '  ← 空。アンケート設問が未投入'
            : ''
      console.log(`  ${t.padEnd(22)} ${String(n).padStart(6)} 件${hint}`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[db:check] failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
