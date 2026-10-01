import { randomInt } from 'node:crypto'
import type { DbClient } from '../db/client.js'

/**
 * ブース QR 用の短縮トークン（issue #155）。
 *
 * 掲示 QR を `https://<host>/c/<token>` にして、URL を 30 文字前後まで縮める。
 * `manual_code` はイベント単位でしか一意でないので流用できない。このトークンは
 * **グローバル一意**（`UNIQUE (qr_token)`）で、URL から event_id を省く前提になる。
 *
 * - 10 文字。字母は紛らわしい文字（0/O、1/I/L、U）を除いた 30 種
 * - 暗号論的乱数（`node:crypto` の `randomInt`）。`Math.random()` は使わない
 * - 連番にしない（隣のブースを推測させない）
 * - INSERT 前に SELECT で空きを確認する（さくらプロキシは重複キーエラーを 500 に潰す。AGENTS.md 原則2）
 * - 生成した値をログ・audit_logs の本文へ出さない
 */

export const QR_TOKEN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
export const QR_TOKEN_LENGTH = 10

/** 10 文字のトークンを 1 つ返す（暗号論的乱数）。 */
export function generateQrToken(): string {
  let token = ''
  for (let i = 0; i < QR_TOKEN_LENGTH; i++) {
    token += QR_TOKEN_ALPHABET[randomInt(0, QR_TOKEN_ALPHABET.length)]
  }
  return token
}

/** トークンとして妥当な形か（字母・長さ）。 */
export function isValidQrToken(value: string): boolean {
  return (
    value.length === QR_TOKEN_LENGTH &&
    [...value].every((c) => QR_TOKEN_ALPHABET.includes(c))
  )
}

const MAX_ATTEMPTS = 8

/**
 * 全イベントを通して衝突しないトークンを採番する。
 * 数回引き直しても空かなければ例外を投げる。
 */
export async function generateUniqueQrToken(db: DbClient): Promise<string> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const token = generateQrToken()
    const [rows] = await db.query(
      'SELECT 1 AS x FROM booths WHERE qr_token = ? LIMIT 1',
      [token],
    )
    if (!(rows as unknown[])[0]) return token
  }
  throw new Error(`QR トークンの採番に${MAX_ATTEMPTS}回失敗しました`)
}
