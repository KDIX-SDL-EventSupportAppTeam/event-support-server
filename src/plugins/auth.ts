import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { verifyAccessToken, verifyOrganizerToken, type JwtPayload } from '../lib/jwt.js'
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

export async function requireManager(
  this: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  await requireBearerAuth.call(this, req, reply)
  if (reply.sent) return
  if (req.jwtUser?.role !== 'manager') {
    return sendFail(reply, 403, 'FORBIDDEN', '運営権限が必要です')
  }
}

export async function requireStaff(
  this: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  await requireBearerAuth.call(this, req, reply)
  if (reply.sent) return
  const role = req.jwtUser?.role
  if (role !== 'manager' && role !== 'viewer') {
    return sendFail(reply, 403, 'FORBIDDEN', 'スタッフ権限が必要です')
  }
}

export async function requireOrganizer(
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
    req.organizerUser = verifyOrganizerToken(this.config.jwtSecret, token)
  } catch {
    return sendFail(reply, 401, 'UNAUTHORIZED', '認証に失敗しました')
  }
}

/**
 * メール確認済みを要求する preHandler。requireBearerAuth の後に置く。
 * - JWT でなく DB を毎回参照する（確認完了はトークン再発行なしで即反映させるため。#53 の
 *   「JWT の role だけに頼らない」方針と同じ理由）
 * - participant 以外（manager/viewer/exhibitor 等）は対象外: 運営発行アカウントは
 *   実在メールを受信できない可能性があるため（招待スタッフ・初期manager・出展者一括登録）
 */
export async function requireVerifiedEmail(
  this: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const uid = req.jwtUser!.sub
  const [rows] = await this.db.query(
    'SELECT role, email_verified_at FROM users WHERE id = ? LIMIT 1',
    [uid],
  )
  const u = (rows as { role: string | null; email_verified_at: string | null }[])[0]
  if (!u) return sendFail(reply, 401, 'UNAUTHORIZED', 'ユーザーが見つかりません')
  const isParticipant = !u.role || u.role === 'participant'
  if (isParticipant && !u.email_verified_at) {
    return sendFail(
      reply, 403, 'EMAIL_NOT_VERIFIED',
      'メールアドレスの確認が完了していません。登録メールの確認URLを開くか、確認メールを再送してください',
    )
  }
}

// 後方互換: requireAdmin は requireManager の別名として保持
export const requireAdmin = requireManager
