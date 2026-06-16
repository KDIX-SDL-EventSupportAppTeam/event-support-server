import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { verifyAccessToken, type JwtPayload } from '../lib/jwt.js'
import { sendFail } from '../lib/response.js'

export async function requireBearerAuth(
  this: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const raw = req.headers.authorization
  if (!raw?.startsWith('Bearer ')) {
    return sendFail(reply, 401, 'UNAUTHORIZED', '認証が必要です')
  }
  const token = raw.slice('Bearer '.length).trim()
  try {
    req.jwtUser = verifyAccessToken(this.config.jwtSecret, token)
  } catch {
    return sendFail(reply, 401, 'UNAUTHORIZED', '認証に失敗しました')
  }
}

export async function requireEventMatchesJwt(
  req: FastifyRequest<{ Params: { event_id: string } }>,
  reply: FastifyReply,
) {
  const eid = req.params.event_id
  if (req.jwtUser!.event_id !== eid) {
    return sendFail(reply, 403, 'FORBIDDEN', 'このイベントにアクセスできません')
  }
}

export async function requireAdmin(
  this: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  await requireBearerAuth.call(this, req, reply)
  if (reply.sent) return
  if (req.jwtUser?.role !== 'admin') {
    return sendFail(reply, 403, 'FORBIDDEN', '運営権限が必要です')
  }
}
