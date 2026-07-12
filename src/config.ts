import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().optional(),
  SAKURA_PROXY_URL: z.string().optional(),
  SAKURA_PROXY_KEY: z.string().optional(),
  JWT_SECRET: z.string().min(1),
  WEBHOOK_API_KEY: z.string().optional().default(''),
  RECOMMENDER_URL: z.string().optional().default(''),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  ADMIN_REGISTRATION_KEY: z.string().min(1),
  FRONTEND_BASE_URL: z.string().optional(),
  ORGANIZER_REGISTRATION_KEY: z.string().optional(),
  ORGANIZER_SIGNUP_MODE: z.enum(['invite', 'open']).default('invite'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional().default('PRoToFES <no-reply@example.com>'),
})

export type AppConfig = {
  port: number
  databaseUrl: string | undefined
  sakuraProxyUrl: string | undefined
  sakuraProxyKey: string | undefined
  jwtSecret: string
  webhookApiKey: string
  recommenderUrl: string
  corsOrigin: string
  adminRegistrationKey: string
  frontendBaseUrl: string | undefined
  organizerRegistrationKey: string | undefined
  organizerSignupMode: 'invite' | 'open'
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

  if (e.ORGANIZER_SIGNUP_MODE === 'invite' && !e.ORGANIZER_REGISTRATION_KEY) {
    console.warn(
      'ORGANIZER_SIGNUP_MODE=invite ですが ORGANIZER_REGISTRATION_KEY が未設定です。' +
        'オーガナイザー登録（POST /api/v1/organizer/auth/register）は常に 403 になります。',
    )
  }

  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    sakuraProxyUrl: e.SAKURA_PROXY_URL,
    sakuraProxyKey: e.SAKURA_PROXY_KEY,
    jwtSecret: e.JWT_SECRET,
    webhookApiKey: e.WEBHOOK_API_KEY,
    recommenderUrl: e.RECOMMENDER_URL,
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
