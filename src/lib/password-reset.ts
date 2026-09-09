import { randomBytes } from 'node:crypto'
import type { DbClient } from '../db/client.js'
import type { AppConfig } from '../config.js'
import { dateToMysqlUtc } from './datetime.js'

/**
 * パスワード再設定（issue #125）。
 *
 * `email-verification.ts` と同じ構造。ただし**用途が混ざると事故になる**ため
 * （確認メールのリンクでパスワードを変えられる等）、トークン表は別
 * （`password_reset_tokens`）。有効期限は確認メール（24h）より短い **1時間**。
 */
export const PASSWORD_RESET_TOKEN_TTL_HOURS = 1

/** 既存トークンを全部消してから新規発行する（1ユーザーにつき有効な1本だけ）。 */
export async function issuePasswordResetToken(db: DbClient, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex') // 64桁hex = CHAR(64) PK
  const expiresAt = dateToMysqlUtc(
    new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_HOURS * 3600 * 1000),
  )
  await db.execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [userId])
  await db.execute(
    'INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?,?,?)',
    [token, userId, expiresAt],
  )
  return token
}

/** フロントの再設定画面 URL。ルートは `/reset-password/:token`（token はパス）。 */
export function buildResetPasswordUrl(config: AppConfig, token: string): string {
  const base = config.frontendBaseUrl ?? config.corsOrigin.split(',')[0].trim() // lib/url.ts と同式
  return `${base}/reset-password/${token}`
}

export function buildPasswordResetMailText(displayName: string, url: string): string {
  return [
    `${displayName} 様`,
    '',
    'PRoToFES イベントアプリのパスワード再設定のご案内です。',
    '以下の URL を開いて、新しいパスワードを設定してください。',
    '',
    url,
    '',
    `このリンクの有効期限は ${PASSWORD_RESET_TOKEN_TTL_HOURS} 時間です。`,
    'このメールに心当たりがない場合は、破棄してください（パスワードは変更されません）。',
  ].join('\n')
}
