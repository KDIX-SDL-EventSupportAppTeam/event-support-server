import mysql from 'mysql2/promise'
import type { AppConfig } from '../config.js'
import { parseMysqlUrl } from './parse-mysql-url.js'

export function createPool(config: AppConfig) {
  const o = parseMysqlUrl(config.databaseUrl)
  return mysql.createPool({
    ...o,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z',
    dateStrings: true,
  })
}

export type DbPool = ReturnType<typeof createPool>
