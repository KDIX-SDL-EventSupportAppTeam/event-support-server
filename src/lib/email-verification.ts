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

/**
 * 確認メールの本文（テキスト版）。何のメールか・誰が送っているか・有効期限を書く（issue #157）。
 * 「迷惑メールフォルダを確認してください」は書かない（届いた人には不要。待機画面に案内がある）。
 * HTML 版（{@link buildVerificationMailHtml}）と同じ内容にすること。食い違いは減点対象になる。
 */
export function buildVerificationMailText(displayName: string, url: string): string {
  return [
    `${displayName} 様`,
    '',
    'PRoToFES イベントアプリへのご登録ありがとうございます。',
    'このメールは PRoToFES 運営から、ご登録のメールアドレスの確認のためにお送りしています。',
    '以下の URL を開いて、メールアドレスの確認を完了してください。',
    '',
    url,
    '',
    `このリンクの有効期限は ${VERIFICATION_TOKEN_TTL_HOURS} 時間です。`,
    '心当たりがない場合は、このメールは破棄してください。',
    '',
    '--',
    'PRoToFES 運営',
  ].join('\n')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 確認メールの本文（HTML 版）。最小限のインライン CSS のみ。外部画像は埋め込まない
 * （外部画像の読み込みは迷惑メール判定で減点要因になり得る）。
 * リンクはアンカーテキストにする。内容はテキスト版と揃える。
 */
export function buildVerificationMailHtml(displayName: string, url: string): string {
  const safeUrl = escapeHtml(url)
  return [
    '<!doctype html>',
    '<html lang="ja"><body style="font-family:sans-serif;line-height:1.7;color:#222;">',
    `<p>${escapeHtml(displayName)} 様</p>`,
    '<p>PRoToFES イベントアプリへのご登録ありがとうございます。<br>',
    'このメールは PRoToFES 運営から、ご登録のメールアドレスの確認のためにお送りしています。</p>',
    `<p>以下のリンクを開いて、メールアドレスの確認を完了してください。</p>`,
    `<p><a href="${safeUrl}">メールアドレスを確認する</a></p>`,
    `<p>リンクが開けない場合は、次の URL をブラウザに貼り付けてください。<br>${safeUrl}</p>`,
    `<p>このリンクの有効期限は ${VERIFICATION_TOKEN_TTL_HOURS} 時間です。<br>`,
    '心当たりがない場合は、このメールは破棄してください。</p>',
    '<p>--<br>PRoToFES 運営</p>',
    '</body></html>',
  ].join('\n')
}
