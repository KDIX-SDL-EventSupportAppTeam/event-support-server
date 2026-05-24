import jwt from 'jsonwebtoken'
import type { DbPool } from '../db/pool.js'

export type JwtPayload = {
  sub: string
  event_id: string
  display_name: string
  role?: 'admin' | 'participant'
}

export async function signAccessToken(
  pool: DbPool,
  secret: string,
  userId: string,
  eventId: string,
  displayName: string,
  role: JwtPayload['role'] = 'participant',
): Promise<string> {
  const [rows] = await pool.query('SELECT date_end FROM events WHERE id = ? LIMIT 1', [eventId])
  const list = rows as { date_end: string }[]
  const row = list[0]
  const endMs = row ? new Date(`${row.date_end.replace(' ', 'T')}Z`).getTime() : NaN
  const expSec = Number.isFinite(endMs)
    ? Math.floor(endMs / 1000) + 86_400
    : Math.floor(Date.now() / 1000) + 7 * 86_400

  const payload: JwtPayload = {
    sub: userId,
    event_id: eventId,
    display_name: displayName,
    role,
  }
  let ttl = expSec - Math.floor(Date.now() / 1000)
  if (!Number.isFinite(ttl) || ttl < 3_600) ttl = 7 * 86_400
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: ttl })
}

export function verifyAccessToken(secret: string, token: string): JwtPayload {
  const decoded = jwt.verify(token, secret) as jwt.JwtPayload & Partial<JwtPayload>
  if (!decoded.sub || !decoded.event_id) {
    throw new Error('Invalid token payload')
  }
  return {
    sub: decoded.sub,
    event_id: decoded.event_id,
    display_name: decoded.display_name ?? '',
    role: decoded.role === 'admin' ? 'admin' : 'participant',
  }
}
