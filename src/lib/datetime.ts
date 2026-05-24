/** ISO 8601 → MySQL `DATETIME`（接続 timezone Z 前提で UTC として格納） */
export function isoToMysqlUtc(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    throw new Error('Invalid datetime')
  }
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

export function utcMysqlNow(): string {
  const d = new Date()
  return d.toISOString().slice(0, 19).replace('T', ' ')
}
