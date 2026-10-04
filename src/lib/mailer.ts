import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import type { FastifyBaseLogger } from 'fastify'
import type { AppConfig } from '../config.js'

export type Mailer = {
  /** 送信失敗は throw する（呼び出し側で握りつぶすか決める） */
  /**
   * from はイベントの送信元アドレス（Reply-To に入る。From は常に MAIL_FROM）。
   * html を渡すと multipart/alternative で送る（省略可。テキスト版と同じ内容にすること。issue #157）。
   */
  send(
    to: string,
    subject: string,
    text: string,
    from?: string | null,
    html?: string,
  ): Promise<void>
}

/** `名前 <addr@example.com>` / `addr@example.com` からアドレス部分を取り出す。取れなければ null。 */
export function extractMailAddress(value: string): string | null {
  const m = value.match(/<([^<>\s]+@[^<>\s]+)>/) ?? value.match(/^\s*([^<>\s]+@[^<>\s]+)\s*$/)
  return m ? m[1] : null
}

/**
 * sendMail に渡す内容を組み立てる（純関数。送信なしでテストできるようにここへ切り出す）。
 *
 * - From は必ず認証済みの送信元（MAIL_FROM）。SMTP リレー（SendGrid/SES 等）は
 *   未認証ドメインの From を拒否するため、イベント固有の mail_from をそのまま From に
 *   使うと送信自体が失敗する（呼び出し側の catch でエラーが握りつぶされ、本番で
 *   「メールが届かない」だけが観測される事故があった）。返信先だけ Reply-To に入れる。
 *   **From を mail_from に変えないこと。**
 * - List-Unsubscribe は Gmail / Yahoo の一括送信者ガイドラインへの配慮。確認メールは
 *   トランザクションメールで本来不要だが、判定上は有利に働くため付ける。
 *   **配信停止を処理する機能は作らない**ので、運営が手で対応できる mailto: 形式にしている。
 * - Message-ID のドメインは From と揃える（nodemailer の自動生成は送信ホスト名になり得るため）。
 */
export function buildMailOptions(
  config: Pick<AppConfig, 'mailFrom'>,
  msg: { to: string; subject: string; text: string; from?: string | null; html?: string },
) {
  const fromAddress = extractMailAddress(config.mailFrom)
  const domain = fromAddress?.split('@')[1]
  return {
    from: config.mailFrom,
    replyTo: msg.from ?? undefined,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    ...(msg.html ? { html: msg.html } : {}),
    ...(domain ? { messageId: `<${randomUUID()}@${domain}>` } : {}),
    ...(fromAddress
      ? { headers: { 'List-Unsubscribe': `<mailto:${fromAddress}?subject=unsubscribe>` } }
      : {}),
  }
}

/**
 * SMTP_HOST 未設定時は実送信せずログに全文を出す「ログ出力モード」。
 * 開発・CI で実メールなしに動線を検証するための仕組み（確認URLはログから拾う）。
 */
export function createMailer(config: AppConfig, log: FastifyBaseLogger): Mailer {
  if (!config.smtpHost) {
    return {
      async send(to, subject, text, from) {
        log.info({ to, subject, from: from ?? config.mailFrom }, `[mail] SMTP未設定のためログ出力のみ:\n${text}`)
      },
    }
  }
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465, // 465 のみ暗黙TLS。587 は STARTTLS
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  })
  return {
    async send(to, subject, text, from, html) {
      await transporter.sendMail(buildMailOptions(config, { to, subject, text, from, html }))
    },
  }
}
