import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { AppConfig } from './config.js'
import type { DbPool } from './db/pool.js'
import { sendFail } from './lib/response.js'
import { authRoutes } from './routes/v1/auth.js'
import { adminRoutes, webhookRoutes } from './routes/v1/ops.js'
import { participantRoutes } from './routes/v1/participant.js'

export async function buildApp(config: AppConfig, pool: DbPool) {
  const app = Fastify({ logger: true })
  app.decorate('config', config)
  app.decorate('db', pool)

  await app.register(cors, {
    origin: config.corsOrigin.split(',').map((s) => s.trim()),
    credentials: true,
  })

  // ブラウザで http://127.0.0.1:3000/ を開いたときの案内（API は /api/v1）
  app.get('/', async () => ({
    service: 'event-support-server',
    health: '/health',
    api: '/api/v1',
    hint: 'REST は docs/designs/api.md の /api/v1 配下',
  }))

  app.get('/health', async () => ({ ok: true }))

  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: '/auth' })
      await v1.register(participantRoutes)
      await v1.register(webhookRoutes)
      await v1.register(adminRoutes)
    },
    { prefix: '/api/v1' },
  )

  app.setErrorHandler((err, req, reply) => {
    req.log.error(err)
    if (reply.sent) return
    sendFail(reply, 500, 'INTERNAL_ERROR', 'サーバーエラーが発生しました')
  })

  return app
}
