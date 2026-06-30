import jwt from 'jsonwebtoken'
import type { DbClient } from '../db/client.js'

export type JwtPayload = {
  sub: string
  event_id: string
  display_name: string
  role?: 'manager' | 'viewer' | 'participant'
}

export type OrganizerJwtPayload = {
  sub: string
  scope: 'organizer'
  display_name: string
}

export async function signAccessToken(
  pool: DbClient,
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
  let role: JwtPayload['role'] = 'participant'
  if (decoded.role === 'manager') role = 'manager'
  else if (decoded.role === 'viewer') role = 'viewer'
  return {
    sub: decoded.sub,
    event_id: decoded.event_id,
    display_name: decoded.display_name ?? '',
    role,
  }
}

export function signOrganizerToken(
  secret: string,
  organizerId: string,
  displayName: string,
): string {
  const payload: OrganizerJwtPayload = {
    sub: organizerId,
    scope: 'organizer',
    display_name: displayName,
  }
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: 30 * 24 * 3600 })
}

export function verifyOrganizerToken(secret: string, token: string): OrganizerJwtPayload {
  const decoded = jwt.verify(token, secret) as jwt.JwtPayload & Partial<OrganizerJwtPayload>
  if (!decoded.sub || decoded.scope !== 'organizer') {
    throw new Error('Invalid organizer token')
  }
  return {
    sub: decoded.sub,
    scope: 'organizer',
    display_name: decoded.display_name ?? '',
  }
}
