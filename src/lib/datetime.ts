/**
 * Date → MySQL `DATETIME`（'YYYY-MM-DD HH:MM:SS'、UTC）。
 * 日付→DATETIME 文字列の変換はすべてここに集約する（http-proxy・routes 共通）。
 */
export function dateToMysqlUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** ISO 8601 → MySQL `DATETIME`（接続 timezone Z 前提で UTC として格納） */
export function isoToMysqlUtc(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    throw new Error('Invalid datetime')
  }
  return dateToMysqlUtc(d)
}

export function utcMysqlNow(): string {
  return dateToMysqlUtc(new Date())
}

/** MySQL `DATETIME`（UTC 格納・dateStrings 前提）→ ISO 8601（'...Z'）。 */
export function mysqlUtcToIso(value: string): string {
  return new Date(`${String(value).replace(' ', 'T')}Z`).toISOString()
}
