import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { signAccessToken } from '../../lib/jwt.js'
import { sendFail, sendOk } from '../../lib/response.js'

const registerBody = z.object({
  event_id: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  display_name: z.string().min(1).max(200),
})

const adminRegisterBody = registerBody

const loginBody = z.object({
  event_id: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(1).max(200),
})

type UserRow = {
  id: string
  password_hash: string | null
  display_name: string | null
  role?: string | null
}

function resolveRole(role: string | null | undefined): 'admin' | 'participant' {
  return role === 'admin' ? 'admin' : 'participant'
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/register', async (req, reply) => {
    const parsed = registerBody.safeParse(req.body)
    if (!parsed.success) {
      return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
    }
    const { event_id, email, password, display_name } = parsed.data

    const [ev] = await app.db.query('SELECT id FROM events WHERE id = ? LIMIT 1', [event_id])
    if (!(ev as { id: string }[]).length) {
      return sendFail(reply, 404, 'NOT_FOUND', 'イベントが見つかりません')
    }

    const id = randomUUID()
    const hash = await bcrypt.hash(password, 10)
    try {
      await app.db.execute(
        `INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)`,
        [id, event_id, email.toLowerCase(), hash, display_name, 'participant'],
      )
    } catch (e: unknown) {
      const err = e as { code?: string }
      if (err.code === 'ER_DUP_ENTRY') {
        return sendFail(reply, 409, 'CONFLICT', 'このメールアドレスは既に登録されています')
      }
      throw e
    }

    const token = await signAccessToken(app.db, app.config.jwtSecret, id, event_id, display_name)
    return sendOk(reply, {
      token,
      user: { id, display_name, event_id, role: 'participant' as const },
    })
  })

  app.post('/register/admin', async (req, reply) => {
    const adminKey = req.headers['x-admin-key']
    if (adminKey !== app.config.adminRegistrationKey) {
      return sendFail(reply, 403, 'FORBIDDEN', '運営登録キーが正しくありません')
    }

    const parsed = adminRegisterBody.safeParse(req.body)
    if (!parsed.success) {
      return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
    }
    const { event_id, email, password, display_name } = parsed.data

    const [ev] = await app.db.query('SELECT id FROM events WHERE id = ? LIMIT 1', [event_id])
    if (!(ev as { id: string }[]).length) {
      return sendFail(reply, 404, 'NOT_FOUND', 'イベントが見つかりません')
    }

    const id = randomUUID()
    const hash = await bcrypt.hash(password, 10)
    try {
      await app.db.execute(
        `INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)`,
        [id, event_id, email.toLowerCase(), hash, display_name, 'admin'],
      )
    } catch (e: unknown) {
      const err = e as { code?: string }
      if (err.code === 'ER_DUP_ENTRY') {
        return sendFail(reply, 409, 'CONFLICT', 'このメールアドレスは既に登録されています')
      }
      throw e
    }

    const token = await signAccessToken(
      app.db,
      app.config.jwtSecret,
      id,
      event_id,
      display_name,
      'admin',
    )
    return sendOk(reply, {
      token,
      user: { id, display_name, event_id, role: 'admin' as const },
    })
  })

  app.post('/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body)
    if (!parsed.success) {
      return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
    }
    const { event_id, email, password } = parsed.data

    const [rows] = await app.db.query(
      'SELECT id, password_hash, display_name, role FROM users WHERE event_id = ? AND email = ? LIMIT 1',
      [event_id, email.toLowerCase()],
    )
    const u = (rows as UserRow[])[0]
    if (!u?.password_hash) {
      return sendFail(reply, 401, 'UNAUTHORIZED', 'メールアドレスまたはパスワードが正しくありません')
    }
    const ok = await bcrypt.compare(password, u.password_hash)
    if (!ok) {
      return sendFail(reply, 401, 'UNAUTHORIZED', 'メールアドレスまたはパスワードが正しくありません')
    }

    const displayName = u.display_name ?? ''
    const role = resolveRole(u.role)
    const token = await signAccessToken(
      app.db,
      app.config.jwtSecret,
      u.id,
      event_id,
      displayName,
      role,
    )
    return sendOk(reply, {
      token,
      user: { id: u.id, display_name: displayName, event_id, role },
    })
  })
}
