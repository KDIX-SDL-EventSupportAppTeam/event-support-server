import nodemailer from 'nodemailer'
import type { FastifyBaseLogger } from 'fastify'
import type { AppConfig } from '../config.js'

export type Mailer = {
  /** 送信失敗は throw する（呼び出し側で握りつぶすか決める） */
  /** from はイベントの送信元アドレス。省略時は MAIL_FROM。 */
  send(to: string, subject: string, text: string, from?: string | null): Promise<void>
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
    async send(to, subject, text, from) {
      // From は必ず認証済みの送信元（MAIL_FROM）を使う。SMTP リレー（SendGrid/SES 等）は
      // 未認証ドメインの From を拒否するため、イベント固有の mail_from をそのまま From に
      // 使うと送信自体が失敗する（呼び出し側の catch でエラーが握りつぶされ、本番で
      // 「メールが届かない」だけが観測される事故があった）。返信先だけ Reply-To に入れる。
      await transporter.sendMail({
        from: config.mailFrom,
        replyTo: from ?? undefined,
        to,
        subject,
        text,
      })
    },
  }
}
