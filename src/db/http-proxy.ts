import type { DbClient } from './client.js'

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
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sql, params }),
    })
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
