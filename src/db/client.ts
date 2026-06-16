/**
 * DbPool（mysql2）と HttpProxy の共通インターフェース。
 * routes は app.db.query / app.db.execute のみを使うため、この2メソッドだけ定義する。
 */
export interface DbClient {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>
  end(): Promise<void>
}
