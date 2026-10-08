/**
 * sakura-proxy-mock.ts
 *
 * 目的:
 *   さくら側のラッパーAPIをローカルで再現し、event-support-server の
 *   http-proxy.ts が正しく動くかをローカルで検証する。
 *   テストが通ったら、このファイルをそのまま先生に渡してさくら上に設置してもらう。
 *
 * 起動:
 *   npm run proxy:mock
 *   （.env に SAKURA_PROXY_KEY と DATABASE_URL が必要）
 *
 * さくら設置後のエンドポイント例:
 *   https://example.sakura.ne.jp/proxy/query
 */
import 'dotenv/config'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import mysql from 'mysql2/promise'
import { parseMysqlUrl } from '../db/parse-mysql-url.js'

// ── 環境変数 ────────────────────────────────────────────────────────────
const PROXY_KEY = process.env.SAKURA_PROXY_KEY ?? ''
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 3001)
const DATABASE_URL = process.env.DATABASE_URL ?? ''

if (!PROXY_KEY) {
  console.error('[proxy-mock] SAKURA_PROXY_KEY が未設定です')
  process.exit(1)
}
if (!DATABASE_URL) {
  console.error('[proxy-mock] DATABASE_URL が未設定です')
  process.exit(1)
}

// ── DB接続（ローカル Docker MySQL）──────────────────────────────────────
const pool = mysql.createPool({
  ...parseMysqlUrl(DATABASE_URL),
  waitForConnections: true,
  connectionLimit: 5,
  timezone: 'Z',
  dateStrings: true,
})

// ── ユーティリティ ──────────────────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

// 本物のさくらプロキシ（PDO エミュレートモード）は数値も JSON 列も文字列で返す。
// mysql2 の型付きの値をそのまま返すと本番だけで起きる型の不具合を手元で再現できないため、揃える。
// mysql2 と同じ型で返したいときは PROXY_MOCK_NATIVE_TYPES=1。
const NATIVE_TYPES = process.env.PROXY_MOCK_NATIVE_TYPES === '1'

function stringifyLikePdo(rows: unknown[]): unknown[] {
  if (NATIVE_TYPES) return rows
  return rows.map((row) => {
    if (row === null || typeof row !== 'object') return row
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (typeof v === 'number' || typeof v === 'bigint') out[k] = String(v)
      else if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) out[k] = JSON.stringify(v)
      else out[k] = v
    }
    return out
  })
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

// ── サーバー ────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // POST /query のみ受け付ける
  if (req.method !== 'POST' || req.url !== '/query') {
    return sendJson(res, 404, { error: 'Not Found' })
  }

  // 認証
  if (req.headers['x-proxy-key'] !== PROXY_KEY) {
    return sendJson(res, 401, { error: 'Unauthorized' })
  }

  try {
    const raw = await readBody(req)
    const body = JSON.parse(raw) as { sql?: unknown; params?: unknown }

    if (typeof body.sql !== 'string' || !Array.isArray(body.params)) {
      return sendJson(res, 400, {
        error: 'Bad Request: sql(string) と params(array) が必要です',
      })
    }

    const [result] = await pool.execute(body.sql, body.params)

    if (Array.isArray(result)) {
      // SELECT 系: rows に結果
      return sendJson(res, 200, { rows: stringifyLikePdo(result), affectedRows: result.length, insertId: null })
    } else {
      // INSERT / UPDATE / DELETE 系
      const r = result as { affectedRows: number; insertId: number }
      return sendJson(res, 200, {
        rows: [],
        affectedRows: r.affectedRows,
        insertId: r.insertId ?? null,
      })
    }
  } catch (e) {
    console.error('[proxy-mock] ERROR:', e instanceof Error ? e.message : e)
    return sendJson(res, 500, { error: 'Internal Server Error' })
  }
})

server.listen(PROXY_PORT, () => {
  const safeUrl = DATABASE_URL.replace(/:[^:@/]+@/, ':***@')
  console.log(`[proxy-mock] http://localhost:${PROXY_PORT} で起動中`)
  console.log(`[proxy-mock] DB: ${safeUrl}`)
  console.log(`[proxy-mock] Key prefix: ${PROXY_KEY.slice(0, 4)}...`)
})

// Graceful shutdown
const shutdown = () => pool.end().then(() => server.close(() => process.exit(0)))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
