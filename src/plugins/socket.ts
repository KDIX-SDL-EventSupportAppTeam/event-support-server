import type { FastifyInstance } from 'fastify'
import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import { verifyAccessToken } from '../lib/jwt.js'

/** checkins から参照する最小 API（Fastify 起動前に decorate 可能） */
class SocketIOFacade {
  #io: Server | null = null

  to(room: string | string[]) {
    if (!this.#io) {
      throw new Error('Socket.IO is not initialized yet')
    }
    return this.#io.to(room)
  }

  async close() {
    await this.#io?.close()
    this.#io = null
  }

  init(httpServer: HttpServer, jwtSecret: string, corsOrigins: string[]) {
    const io = new Server(httpServer, {
      cors: { origin: corsOrigins },
    })

    io.use((socket, next) => {
      const token = socket.handshake.auth?.token ?? socket.handshake.query?.token
      if (!token || typeof token !== 'string') {
        return next(new Error('Unauthorized'))
      }
      try {
        socket.data.user = verifyAccessToken(jwtSecret, token)
        next()
      } catch {
        next(new Error('Unauthorized'))
      }
    })

    io.on('connection', (socket) => {
      const user = socket.data.user as ReturnType<typeof verifyAccessToken>
      socket.join(`event:${user.event_id}`)
      if (user.role === 'admin') {
        socket.join(`event:${user.event_id}:admin`)
      }
    })

    this.#io = io
  }
}

/** Fastify 起動前に decorate し、onReady で HTTP サーバーに socket.io を載せる */
export function registerSocketIO(app: FastifyInstance): void {
  const facade = new SocketIOFacade()
  app.decorate('io', facade as unknown as Server)

  app.addHook('onReady', async () => {
    facade.init(
      app.server,
      app.config.jwtSecret,
      app.config.corsOrigin.split(',').map((s) => s.trim()),
    )
  })

  app.addHook('onClose', async () => {
    await facade.close()
  })
}
