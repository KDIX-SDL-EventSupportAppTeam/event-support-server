import type { DbClient } from './client.js'
import { dateToMysqlUtc } from '../lib/datetime.js'

/** さくらプロキシへの1リクエストのタイムアウト（ミリ秒） */
const PROXY_TIMEOUT_MS = 30_000

/**
 * さくら上のラッパーAPIをHTTP経由で呼び出す、mysql2互換クライアント。
 * app.db.query / app.db.execute のインターフェースはそのままなので、
 * routes 側を一切変更せずに切り替えられる。
 */
export function createHttpProxy(baseUrl: string, apiKey: string): DbClient {
  const headers = {
    'Content-Type': 'application/json',
    'X-Proxy-Key': apiKey,
  } as const

  async function callProxy(sql: string, params: unknown[]) {
    // さくらMySQL は JSON boolean/Date をそのままバインドできないため変換する
    // boolean → 0/1、Date → 'YYYY-MM-DD HH:MM:SS'（MySQL DATETIME 形式）
    const normalizedParams = params.map((p) => {
      if (typeof p === 'boolean') return p ? 1 : 0
      if (p instanceof Date) return dateToMysqlUtc(p)
      return p
    })
    // プロキシが無応答のまま接続を専有し続けるのを防ぐ
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sql, params: normalizedParams }),
        signal: controller.signal,
      })
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`[sakura-proxy] timeout after ${PROXY_TIMEOUT_MS}ms`)
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error(
        `[sakura-proxy] ${res.status}: ${(body as { error?: string }).error ?? 'error'}`,
      )
    }
    return res.json() as Promise<{
      rows: unknown[]
      affectedRows: number
      insertId: number | null
    }>
  }

  return {
    async query(sql, params = []) {
      const data = await callProxy(sql, params)
      return [data.rows, []]
    },
    async execute(sql, params = []) {
      const data = await callProxy(sql, params)
      return [{ affectedRows: data.affectedRows, insertId: data.insertId }, []]
    },
    async end() {
      // HTTP クライアントはプールを持たないため何もしない
    },
  }
}
