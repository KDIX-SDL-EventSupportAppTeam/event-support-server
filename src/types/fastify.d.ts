import type { AppConfig } from '../config.js'
import type { DbClient } from '../db/client.js'
import type { JwtPayload } from '../lib/jwt.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
    db: DbClient
  }
  interface FastifyRequest {
    jwtUser?: JwtPayload
  }
}
