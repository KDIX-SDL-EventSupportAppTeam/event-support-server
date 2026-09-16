/** mysql2 の接続オプション。Cloud SQL（Unix ソケット）と TCP の両方を表す。 */
export type MysqlConnectionOptions = {
  user: string
  password: string
  database: string
} & ({ socketPath: string } | { host: string; port: number })

/**
 * `DATABASE_URL` を mysql2 の接続オプションに変換する。
 *
 * TCP:    mysql://user:pass@host:3306/event_support
 * ソケット: mysql://user:pass@localhost/event_support?socket=/cloudsql/<接続名>
 *
 * Cloud Run から Cloud SQL へは Unix ソケット（`/cloudsql/<接続名>`）で繋ぐため、
 * `?socket=` があればホスト・ポートを無視して socketPath を使う。
 */
export function parseMysqlUrl(urlStr: string): MysqlConnectionOptions {
  const u = new URL(urlStr)
  if (u.protocol !== 'mysql:' && u.protocol !== 'mysql2:') {
    throw new Error(`Unsupported DATABASE_URL protocol: ${u.protocol}`)
  }
  const database = u.pathname.replace(/^\//, '')
  if (!database) {
    throw new Error(
      'DATABASE_URL must include a database name, e.g. mysql://user:pass@host:3306/event_support',
    )
  }
  const credentials = {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
  }

  const socketPath = u.searchParams.get('socket') ?? u.searchParams.get('socketPath')
  if (socketPath) {
    return { ...credentials, socketPath }
  }

  return {
    ...credentials,
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
  }
}

/** ログ表示用の接続先。socketPath 経路とTCP経路で出し分ける。 */
export function describeTarget(opts: MysqlConnectionOptions): string {
  return 'socketPath' in opts ? opts.socketPath : `${opts.host}:${opts.port}`
}
