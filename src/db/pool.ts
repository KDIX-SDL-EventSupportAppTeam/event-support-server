import mysql from 'mysql2/promise'
import type { ExecuteValues } from 'mysql2'
import type { AppConfig } from '../config.js'
import type { DbClient } from './client.js'
import { parseMysqlUrl } from './parse-mysql-url.js'

export function createPool(config: AppConfig): DbClient {
  const pool = mysql.createPool({
    ...parseMysqlUrl(config.databaseUrl!),
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z',
    dateStrings: true,
  })
  return {
    query: (sql, params = []) =>
      pool.query(sql, params as ExecuteValues) as Promise<[unknown, unknown]>,
    execute: (sql, params = []) =>
      pool.execute(sql, params as ExecuteValues) as Promise<[unknown, unknown]>,
    end: () => pool.end(),
    getConnection: async () => {
      const conn = await pool.getConnection()
      return {
        query: (sql, params = []) =>
          conn.query(sql, params as ExecuteValues) as Promise<[unknown, unknown]>,
        execute: (sql, params = []) =>
          conn.execute(sql, params as ExecuteValues) as Promise<[unknown, unknown]>,
        beginTransaction: () => conn.beginTransaction(),
        commit: () => conn.commit(),
        rollback: () => conn.rollback(),
        release: () => conn.release(),
      }
    },
  }
}
