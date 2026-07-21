import nodemailer from 'nodemailer'
import type { FastifyBaseLogger } from 'fastify'
import type { AppConfig } from '../config.js'

export type Mailer = {
  /** 送信失敗は throw する（呼び出し側で握りつぶすか決める） */
  send(to: string, subject: string, text: string): Promise<void>
}

/**
 * SMTP_HOST 未設定時は実送信せずログに全文を出す「ログ出力モード」。
 * 開発・CI で実メールなしに動線を検証するための仕組み（確認URLはログから拾う）。
 */
export function createMailer(config: AppConfig, log: FastifyBaseLogger): Mailer {
  if (!config.smtpHost) {
    return {
      async send(to, subject, text) {
        log.info({ to, subject }, `[mail] SMTP未設定のためログ出力のみ:\n${text}`)
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
    async send(to, subject, text) {
      await transporter.sendMail({ from: config.mailFrom, to, subject, text })
    },
  }
}
