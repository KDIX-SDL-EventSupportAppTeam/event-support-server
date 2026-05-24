export function parseMysqlUrl(urlStr: string) {
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
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
  }
}
