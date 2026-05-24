import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  WEBHOOK_API_KEY: z.string().optional().default(''),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
})

export type AppConfig = {
  port: number
  databaseUrl: string
  jwtSecret: string
  webhookApiKey: string
  corsOrigin: string
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors
    throw new Error(`Invalid env: ${JSON.stringify(msg)}`)
  }
  const e = parsed.data
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    webhookApiKey: e.WEBHOOK_API_KEY,
    corsOrigin: e.CORS_ORIGIN,
  }
}
