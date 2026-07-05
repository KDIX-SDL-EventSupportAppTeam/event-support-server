/** トランザクション用の単一コネクション。mysql2 経路のみ提供される。 */
export interface DbConnection {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
}

/**
 * DbPool（mysql2）と HttpProxy の共通インターフェース。
 * routes は app.db.query / app.db.execute のみを使うため、この2メソッドだけ定義する。
 */
export interface DbClient {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>
  end(): Promise<void>
  /** トランザクションが使える場合のみ実装される（mysql2 プール経路のみ）。 */
  getConnection?(): Promise<DbConnection>
}
