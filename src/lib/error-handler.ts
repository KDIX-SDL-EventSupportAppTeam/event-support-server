import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { sendFail } from './response.js'

/** Fastify 自身が付ける 4xx（不正 JSON・本文サイズ超過・未対応の Content-Type 等）を API の形式に直すための対応表。 */
const CLIENT_ERRORS: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'リクエストが不正です' },
  401: { code: 'UNAUTHORIZED', message: '認証が必要です' },
  403: { code: 'FORBIDDEN', message: '権限がありません' },
  404: { code: 'NOT_FOUND', message: '見つかりません' },
  405: { code: 'METHOD_NOT_ALLOWED', message: '許可されていないメソッドです' },
  409: { code: 'CONFLICT', message: '競合しています' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'リクエストが大きすぎます' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '対応していない形式です' },
  429: { code: 'TOO_MANY_REQUESTS', message: 'リクエストが多すぎます' },
}

/**
 * グローバルエラーハンドラー。
 * - err.statusCode が 400〜499: その値で返す（クライアント起因。ログは warn）
 * - それ以外: 500 INTERNAL_ERROR（サーバー起因。ログは error）。内部メッセージは返さない
 */
export function globalErrorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  const status = err.statusCode
  const isClientError = typeof status === 'number' && status >= 400 && status < 500

  if (isClientError) req.log.warn(err)
  else req.log.error(err)

  if (reply.sent) return

  if (isClientError) {
    const mapped = CLIENT_ERRORS[status] ?? CLIENT_ERRORS[400]
    return sendFail(reply, status, mapped.code, mapped.message)
  }
  return sendFail(reply, 500, 'INTERNAL_ERROR', 'サーバーエラーが発生しました')
}
