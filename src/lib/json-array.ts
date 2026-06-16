/** JSON カラム / 文字列を UUID 配列に正規化（さくら MySQL は JSON_TABLE 非対応のためアプリ層で使用） */
export function parseJsonStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v) as unknown
      return Array.isArray(p) ? p.map(String) : []
    } catch {
      return []
    }
  }
  return []
}
