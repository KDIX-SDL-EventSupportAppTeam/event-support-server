import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { signAccessToken } from '../../lib/jwt.js'
import { sendFail, sendOk } from '../../lib/response.js'
import { safeCompare } from '../../lib/safe-compare.js'
import { utcMysqlNow } from '../../lib/datetime.js'
import { requireBearerAuth } from '../../plugins/auth.js'
import {
  buildVerificationMailText,
  buildVerifyEmailUrl,
  issueVerificationToken,
} from '../../lib/email-verification.js'

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
  email_verified_at?: string | null
}

/** ユーザー不在時に本物と同程度の時間をかけるためのダミーハッシュ（既知の平文なし） */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(randomUUID(), 10)

function resolveRole(role: string | null | undefined): 'manager' | 'viewer' | 'participant' | 'exhibitor' {
  if (role === 'manager') return 'manager'
  if (role === 'viewer') return 'viewer'
  if (role === 'exhibitor') return 'exhibitor'
  return 'participant'
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

    // さくらプロキシは重複キーを 500 に潰すため、INSERT 前にメール重複を確認する
    const [dupUser] = await app.db.query(
      'SELECT id FROM users WHERE event_id = ? AND email = ? LIMIT 1',
      [event_id, email.toLowerCase()],
    )
    if ((dupUser as { id: string }[])[0]) {
      return sendFail(reply, 409, 'CONFLICT', 'このメールアドレスは既に登録されています')
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

    // メール確認トークンを発行して確認メールを送る。
    // メール送信の失敗で登録自体を失敗させない（再送エンドポイントで回復できる）
    try {
      const vtoken = await issueVerificationToken(app.db, id)
      const url = buildVerifyEmailUrl(app.config, vtoken)
      await app.mailer.send(
        email.toLowerCase(),
        '【PRoToFES】メールアドレスの確認',
        buildVerificationMailText(display_name, url),
      )
    } catch (e) {
      req.log.error(e, 'メール確認トークンの発行または送信に失敗')
    }

    const token = await signAccessToken(app.db, app.config.jwtSecret, id, event_id, display_name)
    return sendOk(reply, {
      token,
      user: { id, display_name, event_id, role: 'participant' as const, email_verified: false },
    })
  })

  app.post('/register/admin', async (req, reply) => {
    const adminKey = req.headers['x-admin-key']
    if (!safeCompare(adminKey, app.config.adminRegistrationKey)) {
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

    // さくらプロキシは重複キーを 500 に潰すため、INSERT 前にメール重複を確認する
    const [dupAdmin] = await app.db.query(
      'SELECT id FROM users WHERE event_id = ? AND email = ? LIMIT 1',
      [event_id, email.toLowerCase()],
    )
    if ((dupAdmin as { id: string }[])[0]) {
      return sendFail(reply, 409, 'CONFLICT', 'このメールアドレスは既に登録されています')
    }

    const id = randomUUID()
    const hash = await bcrypt.hash(password, 10)
    try {
      await app.db.execute(
        `INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)`,
        [id, event_id, email.toLowerCase(), hash, display_name, 'manager'],
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
      'manager',
    )
    return sendOk(reply, {
      token,
      user: { id, display_name, event_id, role: 'manager' as const },
    })
  })

  app.post('/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body)
    if (!parsed.success) {
      return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
    }
    const { event_id, email, password } = parsed.data

    const [rows] = await app.db.query(
      'SELECT id, password_hash, display_name, role, email_verified_at FROM users WHERE event_id = ? AND email = ? LIMIT 1',
      [event_id, email.toLowerCase()],
    )
    const u = (rows as UserRow[])[0]
    const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_PASSWORD_HASH)
    if (!u?.password_hash || !ok) {
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
      user: {
        id: u.id,
        display_name: displayName,
        event_id,
        role,
        email_verified: !!u.email_verified_at,
      },
    })
  })

  const verifyQuery = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) })

  app.get('/verify-email', async (req, reply) => {
    const parsed = verifyQuery.safeParse(req.query)
    if (!parsed.success) {
      return sendFail(reply, 422, 'VALIDATION_ERROR', 'トークンが不正です')
    }
    const { token } = parsed.data

    const [rows] = await app.db.query(
      'SELECT user_id, expires_at FROM email_verification_tokens WHERE token = ? LIMIT 1',
      [token],
    )
    const row = (rows as { user_id: string; expires_at: string }[])[0]
    if (!row) {
      // 使用済み（＝確認済み）の再クリックもここに来る。フロントはその旨を案内文で吸収する
      return sendFail(reply, 404, 'TOKEN_INVALID', 'この確認リンクは無効です')
    }
    // dateStrings: true / timezone: 'Z' なので UTC 文字列 → Z 付き ISO に直して比較（jwt.ts の date_end と同じ流儀）
    const expMs = new Date(`${row.expires_at.replace(' ', 'T')}Z`).getTime()
    if (!Number.isFinite(expMs) || expMs <= Date.now()) {
      await app.db.execute('DELETE FROM email_verification_tokens WHERE token = ?', [token]) // 掃除
      return sendFail(
        reply, 410, 'TOKEN_EXPIRED',
        '確認リンクの有効期限が切れています。確認メールを再送してください',
      )
    }

    await app.db.execute(
      'UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL',
      [utcMysqlNow(), row.user_id],
    )
    await app.db.execute('DELETE FROM email_verification_tokens WHERE user_id = ?', [row.user_id])
    return sendOk(reply, { verified: true })
  })

  app.post('/resend-verification', { preHandler: [requireBearerAuth] }, async (req, reply) => {
    const uid = req.jwtUser!.sub
    const [rows] = await app.db.query(
      'SELECT email, display_name, email_verified_at FROM users WHERE id = ? LIMIT 1',
      [uid],
    )
    const u = (rows as {
      email: string
      display_name: string | null
      email_verified_at: string | null
    }[])[0]
    if (!u) return sendFail(reply, 404, 'NOT_FOUND', 'ユーザーが見つかりません')
    if (u.email_verified_at) {
      return sendFail(reply, 409, 'ALREADY_VERIFIED', 'メールアドレスは既に確認済みです')
    }

    const vtoken = await issueVerificationToken(app.db, uid) // 内部で既存トークン削除→新規発行（issue 指定）
    const url = buildVerifyEmailUrl(app.config, vtoken)
    await app.mailer.send(
      u.email,
      '【PRoToFES】メールアドレスの確認',
      buildVerificationMailText(u.display_name ?? '', url),
    )
    return sendOk(reply, { sent: true })
  })
}
