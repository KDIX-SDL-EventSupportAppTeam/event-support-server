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

  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    sakuraProxyUrl: e.SAKURA_PROXY_URL,
    sakuraProxyKey: e.SAKURA_PROXY_KEY,
    jwtSecret: e.JWT_SECRET,
    webhookApiKey: e.WEBHOOK_API_KEY,
    recommenderUrl: e.RECOMMENDER_URL,
    corsOrigin: e.CORS_ORIGIN,
  }
}
