import type { AppConfig } from '../config.js'
import type { DbPool } from '../db/pool.js'
import type { JwtPayload } from '../lib/jwt.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
    db: DbPool
  }
  interface FastifyRequest {
    jwtUser?: JwtPayload
  }
}
