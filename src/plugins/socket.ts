import type { FastifyInstance } from 'fastify'
import { Server } from 'socket.io'
import { verifyAccessToken } from '../lib/jwt.js'

export function initSocketIO(app: FastifyInstance): Server {
  const io = new Server(app.server, {
    cors: { origin: app.config.corsOrigin.split(',').map((s) => s.trim()) },
  })

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token ?? socket.handshake.query?.token
    if (!token || typeof token !== 'string') {
      return next(new Error('Unauthorized'))
    }
    try {
      const user = verifyAccessToken(app.config.jwtSecret, token)
      socket.data.user = user
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

  app.decorate('io', io)
  app.addHook('onClose', async (instance) => {
    await instance.io.close()
  })

  return io
}
