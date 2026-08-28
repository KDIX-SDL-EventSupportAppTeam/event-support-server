import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().optional(),
  SAKURA_PROXY_URL: z.string().optional(),
  SAKURA_PROXY_KEY: z.string().optional(),
  JWT_SECRET: z.string().min(1),
  WEBHOOK_API_KEY: z.string().optional().default(''),
  RECOMMENDER_URL: z.string().optional().default(''),
  RECOMMENDER_TIMEOUT_MS: z.coerce.number().int().min(1).default(1000),
  CHECKIN_COOLDOWN_SEC: z.coerce.number().int().min(0).default(0),
  RATING_SCALE: z.coerce.number().int().min(2).max(10).default(4),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  ADMIN_REGISTRATION_KEY: z.string().min(1),
  FRONTEND_BASE_URL: z.string().optional(),
  ORGANIZER_REGISTRATION_KEY: z.string().optional(),
  ORGANIZER_SIGNUP_MODE: z.enum(['invite', 'open', 'disabled']).default('invite'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional().default('PRoToFES <no-reply@example.com>'),
})

export type AppConfig = {
  isProduction: boolean
  port: number
  databaseUrl: string | undefined
  sakuraProxyUrl: string | undefined
  sakuraProxyKey: string | undefined
  jwtSecret: string
  webhookApiKey: string
  recommenderUrl: string
  recommenderTimeoutMs: number
  checkinCooldownSec: number
  ratingScale: number
  corsOrigin: string
  adminRegistrationKey: string
  frontendBaseUrl: string | undefined
  organizerRegistrationKey: string | undefined
  organizerSignupMode: 'invite' | 'open' | 'disabled'
  smtpHost: string | undefined
  smtpPort: number
  smtpUser: string | undefined
  smtpPass: string | undefined
  mailFrom: string
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors
    throw new Error(`Invalid env: ${JSON.stringify(msg)}`)
  }
  const e = parsed.data

  if (!e.DATABASE_URL && !e.SAKURA_PROXY_URL) {
    throw new Error('DATABASE_URL または SAKURA_PROXY_URL のいずれかが必要です')
  }

  const isProduction = e.NODE_ENV === 'production'

  // メール確認は登録直後の必須ステップ（06-api.md の状態機械 S2）。SMTP 未設定だと
  // lib/mailer.ts がログ出力に落ち、本番では誰も先へ進めないまま起動してしまう。
  // 設定漏れに気づけないのが最悪なので、本番だけ起動時に落とす。
  if (isProduction && !e.SMTP_HOST) {
    throw new Error(
      'NODE_ENV=production では SMTP_HOST が必須です。' +
        '未設定だと確認メールが送られず、参加者が登録の次に進めません。',
    )
  }

  // 確認メール中の URL は FRONTEND_BASE_URL、無ければ CORS_ORIGIN の先頭を使う（lib/email-verification.ts）。
  // 複数オリジンを並べている本番では先頭が意図した宛先とは限らないため警告する。
  if (isProduction && !e.FRONTEND_BASE_URL) {
    console.warn(
      'FRONTEND_BASE_URL が未設定です。確認メールの URL は CORS_ORIGIN の先頭オリジンになります。',
    )
  }

  if (e.ORGANIZER_SIGNUP_MODE === 'invite' && !e.ORGANIZER_REGISTRATION_KEY) {
    console.warn(
      'ORGANIZER_SIGNUP_MODE=invite ですが ORGANIZER_REGISTRATION_KEY が未設定です。' +
        'オーガナイザー登録（POST /api/v1/organizer/auth/register）は常に 403 になります。',
    )
  }

  return {
    isProduction,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    sakuraProxyUrl: e.SAKURA_PROXY_URL,
    sakuraProxyKey: e.SAKURA_PROXY_KEY,
    jwtSecret: e.JWT_SECRET,
    webhookApiKey: e.WEBHOOK_API_KEY,
    recommenderUrl: e.RECOMMENDER_URL,
    recommenderTimeoutMs: e.RECOMMENDER_TIMEOUT_MS,
    checkinCooldownSec: e.CHECKIN_COOLDOWN_SEC,
    ratingScale: e.RATING_SCALE,
    corsOrigin: e.CORS_ORIGIN,
    adminRegistrationKey: e.ADMIN_REGISTRATION_KEY,
    frontendBaseUrl: e.FRONTEND_BASE_URL,
    organizerRegistrationKey: e.ORGANIZER_REGISTRATION_KEY,
    organizerSignupMode: e.ORGANIZER_SIGNUP_MODE,
    smtpHost: e.SMTP_HOST,
    smtpPort: e.SMTP_PORT,
    smtpUser: e.SMTP_USER,
    smtpPass: e.SMTP_PASS,
    mailFrom: e.MAIL_FROM,
  }
}
