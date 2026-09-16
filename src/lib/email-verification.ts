import { randomBytes } from 'node:crypto'
import type { DbClient } from '../db/client.js'
import type { AppConfig } from '../config.js'
import { dateToMysqlUtc } from './datetime.js'

export const VERIFICATION_TOKEN_TTL_HOURS = 24

/** 既存の未使用トークンを削除して新規発行する（issue 指定の再送仕様と同じ動きに統一） */
export async function issueVerificationToken(db: DbClient, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex') // 64桁hex = CHAR(64) PK にちょうど収まる
  const expiresAt = dateToMysqlUtc(
    new Date(Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 3600 * 1000),
  )
  await db.execute('DELETE FROM email_verification_tokens WHERE user_id = ?', [userId])
  await db.execute(
    'INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES (?,?,?)',
    [token, userId, expiresAt],
  )
  return token
}

/** フロントの確認画面 URL（フロントが GET /auth/verify-email を呼ぶ SPA 構成。#47 §ルート） */
export function buildVerifyEmailUrl(config: AppConfig, token: string): string {
  const base = config.frontendBaseUrl ?? config.corsOrigin.split(',')[0].trim() // lib/url.ts と同式
  return `${base}/verify-email?token=${token}`
}

export function buildVerificationMailText(displayName: string, url: string): string {
  return [
    `${displayName} 様`,
    '',
    'PRoToFES イベントアプリへのご登録ありがとうございます。',
    '以下の URL を開いて、メールアドレスの確認を完了してください。',
    '',
    url,
    '',
    `このリンクの有効期限は ${VERIFICATION_TOKEN_TTL_HOURS} 時間です。`,
    '心当たりがない場合は、このメールは破棄してください。',
  ].join('\n')
}
