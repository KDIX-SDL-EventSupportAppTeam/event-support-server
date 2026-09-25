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

/**
 * 画面の時刻帯ラベル（「10:00」「09:10」など）に使うタイムゾーン。
 * DB の DATETIME は UTC で格納しているため、時刻帯で集計・表示する前にここへ変換する。
 * 変換せずに DATE_FORMAT / getUTCHours すると世界標準時のまま 9 時間前の時刻に出る（手動 E2E NG-11）。
 * 分のオフセットは 0 前提（`MOD(MINUTE(checked_in_at), 10)` は変換前の列を見るため、+05:45 のような値にすると SQL 側だけずれる）。
 */
export const DISPLAY_TZ_OFFSET = '+09:00'
const DISPLAY_TZ_OFFSET_MINUTES = 9 * 60

/**
 * UTC 格納の DATETIME 列を表示タイムゾーンへ変換する SQL 片（数値オフセット指定なので MySQL の tz テーブル不要）
 * column には列名リテラルだけを渡す（SQL に直接埋め込むため）。
 */
export function toDisplayTzSql(column: string): string {
  return `CONVERT_TZ(${column}, '+00:00', '${DISPLAY_TZ_OFFSET}')`
}

/** ISO 8601 → 表示タイムゾーンでの時刻帯ラベル "HH:MM"（stepMinutes 刻みに切り下げ） */
export function toDisplayTimeSlot(iso: string, stepMinutes = 10): string {
  const shifted = new Date(new Date(iso).getTime() + DISPLAY_TZ_OFFSET_MINUTES * 60_000)
  const hh = String(shifted.getUTCHours()).padStart(2, '0')
  const mm = String(Math.floor(shifted.getUTCMinutes() / stepMinutes) * stepMinutes).padStart(2, '0')
  return `${hh}:${mm}`
}
