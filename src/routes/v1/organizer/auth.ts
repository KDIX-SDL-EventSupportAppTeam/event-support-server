import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { signOrganizerToken } from '../../../lib/jwt.js'
import { sendFail, sendOk } from '../../../lib/response.js'
import { safeCompare } from '../../../lib/safe-compare.js'

const registerBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  display_name: z.string().min(1).max(200).optional(),
})

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
})

type OrganizerRow = {
  id: string
  email: string
  password_hash: string
  display_name: string | null
}

export async function organizerAuthRoutes(app: FastifyInstance) {
  app.post('/organizer/auth/register', async (req, reply) => {
    if (app.config.organizerSignupMode === 'invite') {
      const key = req.headers['x-organizer-key']
      if (!app.config.organizerRegistrationKey || !safeCompare(key, app.config.organizerRegistrationKey)) {
        return sendFail(reply, 403, 'FORBIDDEN', 'オーガナイザー登録キーが正しくありません')
      }
    }

    const parsed = registerBody.safeParse(req.body)
    if (!parsed.success) {
      return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
    }
    const { email, password, display_name } = parsed.data

    const [dup] = await app.db.query(
      'SELECT id FROM organizers WHERE email = ? LIMIT 1',
      [email.toLowerCase()],
    )
    if ((dup as { id: string }[])[0]) {
      return sendFail(reply, 409, 'CONFLICT', 'このメールアドレスは既に登録されています')
    }

    const id = randomUUID()
    const hash = await bcrypt.hash(password, 10)
    try {
      await app.db.execute(
        'INSERT INTO organizers (id, email, password_hash, display_name) VALUES (?,?,?,?)',
        [id, email.toLowerCase(), hash, display_name ?? null],
      )
    } catch (e: unknown) {
      const err = e as { code?: string }
      if (err.code === 'ER_DUP_ENTRY') {
        return sendFail(reply, 409, 'CONFLICT', 'このメールアドレスは既に登録されています')
      }
      throw e
    }

    const token = signOrganizerToken(app.config.jwtSecret, id, display_name ?? email)
    return sendOk(
      reply,
      { token, organizer: { id, email: email.toLowerCase(), display_name: display_name ?? null } },
      201,
    )
  })

  app.post('/organizer/auth/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body)
    if (!parsed.success) {
      return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
    }
    const { email, password } = parsed.data

    const [rows] = await app.db.query(
      'SELECT id, email, password_hash, display_name FROM organizers WHERE email = ? LIMIT 1',
      [email.toLowerCase()],
    )
    const org = (rows as OrganizerRow[])[0]
    if (!org) {
      return sendFail(reply, 401, 'UNAUTHORIZED', 'メールアドレスまたはパスワードが正しくありません')
    }
    const ok = await bcrypt.compare(password, org.password_hash)
    if (!ok) {
      return sendFail(reply, 401, 'UNAUTHORIZED', 'メールアドレスまたはパスワードが正しくありません')
    }

    const token = signOrganizerToken(app.config.jwtSecret, org.id, org.display_name ?? org.email)
    return sendOk(reply, {
      token,
      organizer: { id: org.id, email: org.email, display_name: org.display_name },
    })
  })
}
