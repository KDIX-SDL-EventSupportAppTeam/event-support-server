import { describe, expect, it } from 'vitest'
import { describeTarget, parseMysqlUrl } from '../../src/db/parse-mysql-url.js'

describe('parseMysqlUrl', () => {
  it('TCP 接続は host / port を返す', () => {
    const opts = parseMysqlUrl('mysql://app:secret@127.0.0.1:3307/event_support')
    expect(opts).toEqual({
      user: 'app',
      password: 'secret',
      database: 'event_support',
      host: '127.0.0.1',
      port: 3307,
    })
  })

  it('ポート省略時は 3306 を補う', () => {
    const opts = parseMysqlUrl('mysql://app:secret@db.example.test/event_support')
    expect(opts).toMatchObject({ host: 'db.example.test', port: 3306 })
  })

  it('?socket= があれば Cloud SQL の Unix ソケット接続になり host / port を返さない', () => {
    const opts = parseMysqlUrl(
      'mysql://app:secret@localhost/event_support?socket=/cloudsql/proj:asia-northeast1:inst',
    )
    expect(opts).toEqual({
      user: 'app',
      password: 'secret',
      database: 'event_support',
      socketPath: '/cloudsql/proj:asia-northeast1:inst',
    })
  })

  it('パスワードの URL エンコードを復号する', () => {
    const opts = parseMysqlUrl('mysql://app:p%40ss%3Aword@127.0.0.1:3306/event_support')
    expect(opts.password).toBe('p@ss:word')
  })

  it('DB 名が無ければ落ちる', () => {
    expect(() => parseMysqlUrl('mysql://app:secret@127.0.0.1:3306/')).toThrow(
      /must include a database name/,
    )
  })

  it('mysql 以外のスキームは落ちる', () => {
    expect(() => parseMysqlUrl('postgres://app:secret@127.0.0.1:5432/event_support')).toThrow(
      /Unsupported DATABASE_URL protocol/,
    )
  })
})

describe('describeTarget', () => {
  it('TCP は host:port を出す', () => {
    expect(describeTarget(parseMysqlUrl('mysql://a:b@127.0.0.1:3307/db'))).toBe('127.0.0.1:3307')
  })

  it('ソケットはパスを出す', () => {
    expect(describeTarget(parseMysqlUrl('mysql://a:b@localhost/db?socket=/cloudsql/x'))).toBe(
      '/cloudsql/x',
    )
  })
})
