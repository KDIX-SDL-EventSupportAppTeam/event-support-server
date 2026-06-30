import type { AppConfig } from '../config.js'
import type { DbClient } from '../db/client.js'
import type { JwtPayload, OrganizerJwtPayload } from '../lib/jwt.js'
import type { Server } from 'socket.io'

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
    db: DbClient
    io: Server
  }
  interface FastifyRequest {
    jwtUser?: JwtPayload
    organizerUser?: OrganizerJwtPayload
  }
}
