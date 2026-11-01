import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { buildApp } from '../../src/app.js'

/**
 * /health がデプロイ中のコミット・リビジョンを返すことを固定する。
 * 旧リビジョンのまま実機テストをして失敗した経緯（2026-10-06）があり、デプロイ後の確認に使う。
 */

const baseConfig = {
  isProduction: false,
  port: 3000,
  databaseUrl: 'mysql://test',
  jwtSecret: 'test-secret',
  webhookApiKey: '',
  recommenderUrl: '',
  recommenderTimeoutMs: 1000,
  recommenderOpsToken: '',
  recommenderStateTimeoutMs: 2000,
  checkinCooldownSec: 0,
  ratingScale: 4,
  corsOrigin: 'http://localhost:5173',
  adminRegistrationKey: 'k',
  organizerSignupMode: 'invite',
  smtpPort: 587,
  mailFrom: 'from@example.com',
} as AppConfig

const db = {} as DbClient

describe('GET /health', () => {
  it('commit と revision を返す', async () => {
    const app = await buildApp({ ...baseConfig, appCommit: 'abc1234', revision: 'event-support-server-00042-xyz' }, db)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, commit: 'abc1234', revision: 'event-support-server-00042-xyz' })
    await app.close()
  })

  it('未設定なら null を返す', async () => {
    const app = await buildApp(baseConfig, db)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.json()).toEqual({ ok: true, commit: null, revision: null })
    await app.close()
  })
})
