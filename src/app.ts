import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { AppConfig } from './config.js'
import type { DbClient } from './db/client.js'
import { sendFail } from './lib/response.js'
import { authRoutes } from './routes/v1/auth.js'
import { adminRoutes } from './routes/v1/admin/dashboard.js'
import { adminEventRoutes } from './routes/v1/admin/events.js'
import { adminCategoryRoutes } from './routes/v1/admin/categories.js'
import { adminBoothRoutes } from './routes/v1/admin/admin-booths.js'
import { adminSurveyQuestionRoutes } from './routes/v1/admin/survey-questions.js'
import { adminParticipantRoutes } from './routes/v1/admin/participants.js'
import { adminAnalyticsRoutes } from './routes/v1/admin/analytics.js'
import { adminSampleDataRoutes } from './routes/v1/admin/sample-data.js'
import { adminAuditLogRoutes } from './routes/v1/admin/audit-logs.js'
import { organizerAuthRoutes } from './routes/v1/organizer/auth.js'
import { organizerEventRoutes } from './routes/v1/organizer/events.js'
import { organizerStaffRoutes } from './routes/v1/organizer/staff.js'
import { organizerEventDataRoutes } from './routes/v1/organizer/event-data.js'
import { boothRoutes } from './routes/v1/booths.js'
import { checkinRoutes } from './routes/v1/checkins.js'
import { webhookRoutes } from './routes/v1/ops.js'
import { recommendationRoutes } from './routes/v1/recommendations.js'
import { surveyRoutes } from './routes/v1/survey.js'
import { eventsPublicRoutes } from './routes/v1/events-public.js'
import { registerSocketIO } from './plugins/socket.js'

export async function buildApp(config: AppConfig, db: DbClient) {
  const app = Fastify({ logger: true })
  app.decorate('config', config)
  app.decorate('db', db)

  await app.register(cors, {
    origin: config.corsOrigin.split(',').map((s) => s.trim()),
    credentials: true,
  })

  // ブラウザで http://127.0.0.1:3000/ を開いたときの案内（API は /api/v1）
  app.get('/', async () => ({
    service: 'event-support-server',
    health: '/health',
    api: '/api/v1',
    hint: 'REST は docs/legacy/designs/api.md の /api/v1 配下',
  }))

  app.get('/health', async () => ({ ok: true }))

  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: '/auth' })
      await v1.register(surveyRoutes)
      await v1.register(eventsPublicRoutes)
      await v1.register(boothRoutes)
      await v1.register(checkinRoutes)
      await v1.register(recommendationRoutes)
      await v1.register(webhookRoutes)
      await v1.register(adminRoutes)
      await v1.register(adminEventRoutes)
      await v1.register(adminCategoryRoutes)
      await v1.register(adminBoothRoutes)
      await v1.register(adminSurveyQuestionRoutes)
      await v1.register(adminParticipantRoutes)
      await v1.register(adminAnalyticsRoutes)
      await v1.register(adminSampleDataRoutes)
      await v1.register(adminAuditLogRoutes)
      await v1.register(organizerAuthRoutes)
      await v1.register(organizerEventRoutes)
      await v1.register(organizerStaffRoutes)
      await v1.register(organizerEventDataRoutes)
    },
    { prefix: '/api/v1' },
  )

  app.setErrorHandler((err, req, reply) => {
    req.log.error(err)
    if (reply.sent) return
    sendFail(reply, 500, 'INTERNAL_ERROR', 'サーバーエラーが発生しました')
  })

  registerSocketIO(app)

  return app
}
