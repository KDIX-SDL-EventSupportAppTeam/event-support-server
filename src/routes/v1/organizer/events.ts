import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { signAccessToken } from '../../../lib/jwt.js'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireOrganizer } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'
import { buildEventUrls } from '../../../lib/url.js'
import { assertEventOwnedByOrganizer } from '../../../lib/organizer.js'

/** DB から取得したイベント行（日時は MySQL DATETIME 文字列）。 */
type EventRow = {
  id: string
  name: string
  date_start: string
  date_end: string
  venue: string | null
  created_at: string
}

type EventStats = { participants: number; booths: number; checkins: number }

const toIso = (v: string): string => `${String(v).replace(' ', 'T')}Z`

/**
 * 複数イベントの統計（参加者 / ブース / チェックイン）をまとめて集計する。
 * イベントごとにクエリを発行せず、`WHERE event_id IN (...) GROUP BY event_id` を
 * 3 本だけ発行して N+1 を避ける（.sdd 01-api.md 2 の実装上の注意）。
 */
async function fetchStatsForEvents(
  app: FastifyInstance,
  eventIds: string[],
): Promise<Map<string, EventStats>> {
  const stats = new Map<string, EventStats>()
  for (const id of eventIds) {
    stats.set(id, { participants: 0, booths: 0, checkins: 0 })
  }
  if (eventIds.length === 0) return stats

  const placeholders = eventIds.map(() => '?').join(',')

  const accumulate = async (
    sql: string,
    key: keyof EventStats,
  ): Promise<void> => {
    const [rows] = await app.db.query(sql, eventIds)
    for (const r of rows as { event_id: string; c: number | string }[]) {
      const entry = stats.get(r.event_id)
      if (entry) entry[key] = Number(r.c)
    }
  }

  await accumulate(
    `SELECT event_id, COUNT(*) AS c FROM users
     WHERE role = 'participant' AND event_id IN (${placeholders})
     GROUP BY event_id`,
    'participants',
  )
  await accumulate(
    `SELECT event_id, COUNT(*) AS c FROM booths
     WHERE event_id IN (${placeholders}) GROUP BY event_id`,
    'booths',
  )
  await accumulate(
    `SELECT event_id, COUNT(*) AS c FROM check_ins
     WHERE event_id IN (${placeholders}) GROUP BY event_id`,
    'checkins',
  )

  return stats
}

/** イベント行 + 統計を API レスポンス契約（.sdd 01-api.md 2）の形へ整形する。 */
function toEventPayload(
  app: FastifyInstance,
  row: EventRow,
  stats: EventStats,
) {
  return {
    id: row.id,
    name: row.name,
    date_start: toIso(row.date_start),
    date_end: toIso(row.date_end),
    venue: row.venue,
    created_at: toIso(row.created_at),
    stats,
    urls: buildEventUrls(app.config, row.id),
  }
}

const createEventBody = z.object({
  name: z.string().min(1).max(255),
  date_start: z.string().min(1),
  date_end: z.string().min(1),
  venue: z.string().max(500).optional(),
  initial_manager: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
    display_name: z.string().min(1).max(200).optional(),
  }),
})

export async function organizerEventRoutes(app: FastifyInstance) {
  const pre = [requireOrganizer]

  // オーガナイザーが所有するイベント一覧（date_start DESC）
  app.get(
    '/organizer/events',
    { preHandler: pre },
    async (req, reply) => {
      const organizerId = req.organizerUser!.sub
      const [rows] = await app.db.query(
        `SELECT id, name, date_start, date_end, venue, created_at
         FROM events WHERE organizer_id = ?
         ORDER BY date_start DESC`,
        [organizerId],
      )
      const events = rows as EventRow[]
      if (events.length === 0) {
        return sendOk(reply, { events: [] })
      }
      const stats = await fetchStatsForEvents(
        app,
        events.map((e) => e.id),
      )
      return sendOk(reply, {
        events: events.map((e) =>
          toEventPayload(app, e, stats.get(e.id) ?? { participants: 0, booths: 0, checkins: 0 }),
        ),
      })
    },
  )

  // イベント詳細（所有していない・存在しない場合は 403 で区別しない）
  app.get<{ Params: { event_id: string } }>(
    '/organizer/events/:event_id',
    { preHandler: pre },
    async (req, reply) => {
      const organizerId = req.organizerUser!.sub
      const { event_id } = req.params

      const [rows] = await app.db.query(
        `SELECT id, name, date_start, date_end, venue, created_at
         FROM events WHERE id = ? AND organizer_id = ? LIMIT 1`,
        [event_id, organizerId],
      )
      const event = (rows as EventRow[])[0]
      if (!event) {
        return sendFail(reply, 403, 'FORBIDDEN', 'このイベントへのアクセス権限がありません')
      }

      const stats = await fetchStatsForEvents(app, [event_id])
      return sendOk(reply, {
        event: toEventPayload(
          app,
          event,
          stats.get(event_id) ?? { participants: 0, booths: 0, checkins: 0 },
        ),
      })
    },
  )

  app.post(
    '/organizer/events',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = createEventBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const body = parsed.data
      const organizerId = req.organizerUser!.sub

      const eventId = randomUUID()
      const managerId = randomUUID()
      const managerHash = await bcrypt.hash(body.initial_manager.password, 10)
      const managerDisplayName = body.initial_manager.display_name ?? body.initial_manager.email
      const managerEmail = body.initial_manager.email.toLowerCase()

      const conn = await app.db.getConnection?.()

      if (conn) {
        // トランザクション対応（接続プールが getConnection をサポートする場合）
        try {
          await conn.beginTransaction()

          await conn.execute(
            'INSERT INTO events (id, organizer_id, name, date_start, date_end, venue) VALUES (?,?,?,?,?,?)',
            [eventId, organizerId, body.name, body.date_start, body.date_end, body.venue ?? null],
          )

          await conn.execute(
            'INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)',
            [managerId, eventId, managerEmail, managerHash, managerDisplayName, 'manager'],
          )

          await conn.execute(
            `INSERT INTO audit_logs (id, event_id, actor_id, actor_role, action, target_type, target_id, detail)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              randomUUID(),
              eventId,
              organizerId,
              'organizer',
              'staff.invite',
              'user',
              managerId,
              JSON.stringify({ email: managerEmail, role: 'manager' }),
            ],
          )

          await conn.commit()
        } catch (e) {
          await conn.rollback()
          throw e
        } finally {
          conn.release()
        }
      } else {
        // getConnection 非対応の場合は順次実行し、失敗時は補償削除する（さくらプロキシ環境等）
        await app.db.execute(
          'INSERT INTO events (id, organizer_id, name, date_start, date_end, venue) VALUES (?,?,?,?,?,?)',
          [eventId, organizerId, body.name, body.date_start, body.date_end, body.venue ?? null],
        )

        try {
          await app.db.execute(
            'INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)',
            [managerId, eventId, managerEmail, managerHash, managerDisplayName, 'manager'],
          )

          await insertAuditLog(app.db, {
            eventId,
            actorId: organizerId,
            actorRole: 'organizer',
            action: 'staff.invite',
            targetType: 'user',
            targetId: managerId,
            detail: { email: managerEmail, role: 'manager' },
          })
        } catch (e) {
          // ON DELETE CASCADE により events に紐づく中間データも削除される
          await app.db.execute('DELETE FROM events WHERE id = ?', [eventId])
          throw e
        }
      }

      const [eventRows] = await app.db.query(
        'SELECT id, name, date_start, date_end, venue FROM events WHERE id = ? LIMIT 1',
        [eventId],
      )
      const event = (eventRows as {
        id: string
        name: string
        date_start: string
        date_end: string
        venue: string | null
      }[])[0]

      const token = await signAccessToken(
        app.db,
        app.config.jwtSecret,
        managerId,
        eventId,
        managerDisplayName,
        'manager',
      )

      const urls = buildEventUrls(app.config, eventId)

      return sendOk(
        reply,
        {
          event,
          initial_manager: {
            id: managerId,
            email: managerEmail,
            display_name: managerDisplayName,
            token,
          },
          urls,
        },
        201,
      )
    },
  )
}
