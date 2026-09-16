import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'

/**
 * 本番で SMTP が未設定のまま起動しないことの検証。
 * メール確認は登録直後の必須ステップなので、送信できない本番は起動させない。
 */

const BASE_ENV = {
  JWT_SECRET: 'secret',
  ADMIN_REGISTRATION_KEY: 'key',
  DATABASE_URL: 'mysql://localhost/test',
  ORGANIZER_SIGNUP_MODE: 'disabled',
}

let saved: NodeJS.ProcessEnv

function setEnv(extra: Record<string, string | undefined>) {
  process.env = { ...BASE_ENV, ...extra } as NodeJS.ProcessEnv
}

beforeEach(() => {
  saved = process.env
})

afterEach(() => {
  process.env = saved
  vi.restoreAllMocks()
})

describe('loadConfig の SMTP 必須チェック', () => {
  it('本番で SMTP_HOST が無ければ起動を止める', () => {
    setEnv({ NODE_ENV: 'production' })
    expect(() => loadConfig()).toThrow(/SMTP_HOST/)
  })

  it('本番でも SMTP_HOST があれば起動できる', () => {
    setEnv({
      NODE_ENV: 'production',
      SMTP_HOST: 'smtp.example.com',
      FRONTEND_BASE_URL: 'https://event.example.com',
    })
    const config = loadConfig()
    expect(config.isProduction).toBe(true)
    expect(config.smtpHost).toBe('smtp.example.com')
  })

  it('開発では SMTP_HOST が無くても起動できる（ログ出力モード）', () => {
    setEnv({ NODE_ENV: 'development' })
    const config = loadConfig()
    expect(config.isProduction).toBe(false)
    expect(config.smtpHost).toBeUndefined()
  })

  it('本番で FRONTEND_BASE_URL が無ければ警告する', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setEnv({ NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com' })
    loadConfig()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FRONTEND_BASE_URL'))
  })
})
