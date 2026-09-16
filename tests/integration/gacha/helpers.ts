/**
 * ガチャコイン結合テストの共通ヘルパー。
 *
 * ローカル MySQL（docker compose の event-support-mysql）に対して実行する。
 * 仕様: docs/specs/gacha-and-award/10-testing/concurrency.md
 *
 * ビンゴのセル状態は直接 SQL でセットアップする（チェックイン・推薦を経由しない）。
 * ライン計算の正しさは bingo 側のテストに委ねる（依存の向きをテストでも守る）。
 */
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import mysql from 'mysql2/promise'
import type { AppConfig } from '../../../src/config.js'
import type { DbClient } from '../../../src/db/client.js'
import { sendFail } from '../../../src/lib/response.js'
import { gachaRoutes } from '../../../src/routes/v1/gacha.js'
import { adminGachaRoutes } from '../../../src/routes/v1/admin/gacha.js'
import { organizerGachaSettingsRoutes } from '../../../src/routes/v1/organizer/gacha-settings.js'
import { LINES } from '../../../src/lib/bingo/lines.js'

export const JWT_SECRET = 'integration-test-secret'
const DB_URL =
  process.env.DATABASE_URL ?? 'mysql://app:appsecret@127.0.0.1:3306/event_support'

export const config = {
  port: 3000,
  databaseUrl: DB_URL,
  jwtSecret: JWT_SECRET,
  webhookApiKey: '',
  recommenderUrl: '',
  recommenderTimeoutMs: 1500,
  checkinCooldownSec: 0,
  ratingScale: 4,
  corsOrigin: 'http://localhost:5173',
  adminRegistrationKey: 'k',
  frontendBaseUrl: 'https://front.example',
  organizerSignupMode: 'invite',
} as unknown as AppConfig

/** テスト用の mysql2 プールを DbClient として返す。 */
export function makePool(): DbClient {
  const url = new URL(DB_URL)
  const pool = mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z',
    dateStrings: true,
    multipleStatements: false,
  })
  return {
    query: (sql, params = []) => pool.query(sql, params) as Promise<[unknown, unknown]>,
    execute: (sql, params = []) => pool.execute(sql, params) as Promise<[unknown, unknown]>,
    end: () => pool.end(),
  }
}

/** DB 疎通確認。失敗したら理由を添えて投げる。 */
export async function assertDbReachable(db: DbClient): Promise<void> {
  try {
    await db.query('SELECT 1')
  } catch (e) {
    throw new Error(
      `ローカル MySQL に接続できません（${DB_URL}）。` +
        '`docker compose up -d mysql` で起動してから実行してください。' +
        `\n原因: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

export async function buildGachaApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', config)
  app.decorate('db', db)
  await app.register(
    async (v1) => {
      await v1.register(gachaRoutes)
      await v1.register(adminGachaRoutes)
      await v1.register(organizerGachaSettingsRoutes)
    },
    { prefix: '/api/v1' },
  )
  app.setErrorHandler((err, req, reply) => {
    if (reply.sent) return
    sendFail(reply, 500, 'INTERNAL_ERROR', String(err))
  })
  await app.ready()
  return app
}

export function participantToken(userId: string, eventId: string): string {
  return jwt.sign(
    { sub: userId, event_id: eventId, display_name: 'テスト参加者', role: 'participant' },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
}

export function organizerToken(organizerId: string): string {
  return jwt.sign(
    { sub: organizerId, scope: 'organizer', display_name: '運営' },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
}

export function staffToken(eventId: string, role: 'manager' | 'viewer' = 'manager'): string {
  return jwt.sign(
    { sub: `staff-${randomUUID()}`, event_id: eventId, display_name: 'スタッフ', role },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
}

export interface Fixture {
  eventId: string
  organizerId: string
  userId: string
  token: string
}

/**
 * イベント1件・オーガナイザー1件・ユーザー1名を作る。
 * gacha_settings は明示投入する（is_enabled=1, 1枚/ライン・上限4・ボーナス0）。
 */
export async function seedFixture(
  db: DbClient,
  opts: { userCount?: number } = {},
): Promise<Fixture & { userIds: string[] }> {
  const eventId = randomUUID()
  const organizerId = randomUUID()

  await db.execute(
    `INSERT INTO organizers (id, email, password_hash, display_name) VALUES (?,?,?,?)`,
    [organizerId, `org-${organizerId}@example.com`, 'x', '運営'],
  )

  await db.execute(
    `INSERT INTO events (id, organizer_id, name, date_start, date_end)
     VALUES (?,?,?, '2026-10-16 00:00:00', '2026-10-16 23:59:59')`,
    [eventId, organizerId, 'ガチャ結合テスト'],
  )

  const userCount = opts.userCount ?? 1
  const userIds: string[] = []
  for (let i = 0; i < userCount; i++) {
    const uid = randomUUID()
    userIds.push(uid)
    await db.execute(
      `INSERT INTO users (id, event_id, email, display_name, role, email_verified_at)
       VALUES (?,?,?,?, 'participant', '2026-10-01 00:00:00')`,
      [uid, eventId, `u${i}-${uid}@example.com`, `参加者${i}`],
    )
  }

  await setSettings(db, eventId, { is_enabled: 1, coins_per_line: 1, max_coins: 4, bonus_coins: 0 })

  return {
    eventId,
    organizerId,
    userId: userIds[0],
    userIds,
    token: participantToken(userIds[0], eventId),
  }
}

export async function setSettings(
  db: DbClient,
  eventId: string,
  s: { is_enabled: number; coins_per_line: number; max_coins: number; bonus_coins: number },
): Promise<void> {
  await db.execute(
    `INSERT INTO gacha_settings (event_id, is_enabled, coins_per_line, max_coins, bonus_coins)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       is_enabled = VALUES(is_enabled),
       coins_per_line = VALUES(coins_per_line),
       max_coins = VALUES(max_coins),
       bonus_coins = VALUES(bonus_coins)`,
    [eventId, s.is_enabled, s.coins_per_line, s.max_coins, s.bonus_coins],
  )
}

/**
 * 指定ライン数になるようビンゴのセルを直接セットアップする。
 * - 0..3 本: 行ライン（互いに素）をその本数だけ is_achieved=1 にする → ちょうどその本数成立
 * - 4 本以上: 全16マスを is_achieved=1 にする（行4＋列4＋対角2＝10本成立。earned は上限で頭打ち）
 */
export async function seedLines(
  db: DbClient,
  eventId: string,
  userId: string,
  lines: number,
): Promise<string> {
  let [rows] = await db.query(
    `SELECT id FROM bingo_cards WHERE event_id = ? AND user_id = ? LIMIT 1`,
    [eventId, userId],
  )
  let cardId = (rows as { id: string }[])[0]?.id
  if (!cardId) {
    cardId = randomUUID()
    await db.execute(`INSERT INTO bingo_cards (id, event_id, user_id) VALUES (?,?,?)`, [
      cardId,
      eventId,
      userId,
    ])
  }

  // 16 マスを用意（無ければ作る）
  ;[rows] = await db.query(`SELECT COUNT(*) AS c FROM bingo_cells WHERE card_id = ?`, [cardId])
  if (Number((rows as { c: number }[])[0]?.c ?? 0) === 0) {
    const center = new Set([5, 6, 9, 10])
    const values: unknown[] = []
    const ph: string[] = []
    for (let pos = 0; pos < 16; pos++) {
      ph.push('(?,?,?,?)')
      values.push(randomUUID(), cardId, pos, center.has(pos) ? 'CENTER' : 'OUTER')
    }
    await db.execute(
      `INSERT INTO bingo_cells (id, card_id, position, zone) VALUES ${ph.join(',')}`,
      values,
    )
  }

  await db.execute(`UPDATE bingo_cells SET is_achieved = 0 WHERE card_id = ?`, [cardId])

  let positions: number[]
  if (lines <= 0) {
    positions = []
  } else if (lines >= 4) {
    positions = Array.from({ length: 16 }, (_, i) => i)
  } else {
    positions = LINES.slice(0, lines).flatMap((l) => [...l])
  }

  if (positions.length > 0) {
    await db.execute(
      `UPDATE bingo_cells SET is_achieved = 1 WHERE card_id = ? AND position IN (${positions
        .map(() => '?')
        .join(',')})`,
      [cardId, ...positions],
    )
  }
  return cardId
}

export interface UseResponse {
  statusCode: number
  body: {
    success: boolean
    data?: {
      used: number
      available: number
      earned: number
      coin_index?: number
      used_at?: string
      max_coins: number
      is_enabled: boolean
      lines_completed: number
    }
    error?: { code: string; message: string }
  }
}

/** POST /gacha/coins/use */
export async function useCoinReq(
  app: FastifyInstance,
  eventId: string,
  token: string,
  idempotencyKey: string,
): Promise<UseResponse> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/events/${eventId}/gacha/coins/use`,
    headers: { authorization: `Bearer ${token}` },
    payload: { idempotency_key: idempotencyKey },
  })
  return { statusCode: res.statusCode, body: res.json() }
}

/** GET /gacha/coins */
export async function getCoinsReq(
  app: FastifyInstance,
  eventId: string,
  token: string,
): Promise<UseResponse> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/events/${eventId}/gacha/coins`,
    headers: { authorization: `Bearer ${token}` },
  })
  return { statusCode: res.statusCode, body: res.json() }
}

export async function dumpUses(
  db: DbClient,
  eventId: string,
  userId?: string,
): Promise<{ coin_index: number; idempotency_key: string; user_id: string; used_at: string }[]> {
  const sql = userId
    ? `SELECT coin_index, idempotency_key, user_id, used_at FROM gacha_coin_uses WHERE event_id = ? AND user_id = ? ORDER BY coin_index`
    : `SELECT coin_index, idempotency_key, user_id, used_at FROM gacha_coin_uses WHERE event_id = ? ORDER BY user_id, coin_index`
  const [rows] = await db.query(sql, userId ? [eventId, userId] : [eventId])
  return rows as { coin_index: number; idempotency_key: string; user_id: string; used_at: string }[]
}

/** イベントを消す（FK CASCADE で users / bingo_* / gacha_* も消える）。 */
export async function cleanupEvent(db: DbClient, eventId: string, organizerId?: string): Promise<void> {
  await db.execute(`DELETE FROM events WHERE id = ?`, [eventId])
  if (organizerId) await db.execute(`DELETE FROM organizers WHERE id = ?`, [organizerId])
}
