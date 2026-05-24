import type { FastifyReply } from 'fastify'

export function sendOk<T>(reply: FastifyReply, data: T, status = 200): void {
  void reply.status(status).send({ success: true, data })
}

export function sendFail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.status(status).send({
    success: false,
    error: { code, message },
  })
}
