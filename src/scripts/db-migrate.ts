import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { loadConfig } from '../config.js'
import { parseMysqlUrl } from '../db/parse-mysql-url.js'

const EXPECTED_TABLES = 21
const MIGRATION_FILE = 'create-tables.sql'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const sqlPath = join(repoRoot, 'db', MIGRATION_FILE)

/** `USE dbname;` は DATABASE_URL の DB 名と衝突するため除去する */
function prepareMigrationSql(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*USE\s+\S+/i.test(line))
    .join('\n')
}

async function tableCount(conn: mysql.Connection, schema: string): Promise<number> {
  const [rows] = await conn.query(
    'SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = ?',
    [schema],
  )
  return Number((rows as { c: number }[])[0]?.c ?? 0)
}

async function main() {
  const { databaseUrl } = loadConfig()
  if (!databaseUrl) {
    console.error(
      'db-migrate は DATABASE_URL による直接接続専用です（さくらプロキシ経由の SAKURA_PROXY_URL では実行できません）。' +
        '.env に DATABASE_URL を設定するか、対象 DB に対して mysql CLI で db/create-tables.sql を直接実行してください。',
    )
    process.exit(1)
  }
  const db = parseMysqlUrl(databaseUrl)
  const sql = prepareMigrationSql(readFileSync(sqlPath, 'utf8'))

  const conn = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    multipleStatements: true,
    timezone: 'Z',
  })

  try {
    const before = await tableCount(conn, db.database)
    if (before > 0) {
      console.error(
        `Skip: database "${db.database}" already has ${before} table(s). Use an empty database or drop existing tables first.`,
      )
      process.exit(1)
    }

    await conn.query(sql)

    const after = await tableCount(conn, db.database)
    if (after !== EXPECTED_TABLES) {
      console.error(
        `Migration finished but table count is ${after} (expected ${EXPECTED_TABLES}). Check ${sqlPath} and server logs.`,
      )
      process.exit(1)
    }

    console.log(`Migration OK: ${after} tables created in "${db.database}" (${db.host}:${db.port}).`)
  } finally {
    await conn.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
