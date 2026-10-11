import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireManager, requireStaff, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'
import type { DbClient, DbConnection } from '../../../db/client.js'
import { dateToMysqlUtc } from '../../../lib/datetime.js'

const bulkAccountItem = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200), // auth.ts registerBody と同一制約
  booth_id: z.string().uuid(),
  display_name: z.string().min(1).max(200).optional(), // 省略時は email（staff.ts:90 と同じ流儀）
})
const bulkBody = z.object({
  accounts: z.array(bulkAccountItem).min(1).max(200), // bcrypt cost10 × N のCPU負荷と30sタイムアウト(プロキシ)を考慮した上限
})

type RowStatus = 'created' | 'updated' | 'skipped'

type RowResult =
  | { index: number; email: string; booth_id: string; status: RowStatus; user_id: string }
  | {
      index: number
      email: string
      booth_id: string
      status: 'error'
      error: { code: string; message: string }
    }

type ExistingUserRow = { id: string; role: string }

// ロール変更（docs/specs/exhibitor-list-and-role-change）。参加者 ⇄ 出展者の2方向だけを受け付ける
const roleChangeBody = z.discriminatedUnion('role', [
  z.object({ role: z.literal('exhibitor'), booth_ids: z.array(z.string().uuid()).min(1).max(100) }),
  z.object({ role: z.literal('participant') }),
])

type ExhibitorListRow = {
  user_id: string
  email: string
  display_name: string | null
  created_at: string
  booth_id: string | null
  booth_name: string | null
  display_code: string | null
}

type ExhibitorItem = { user_id: string; email: string; display_name: string | null; created_at: string }
type BoothGroup = {
  booth_id: string
  booth_name: string
  display_code: string | null
  exhibitors: ExhibitorItem[]
}

// ブース番号の自然順（'2' < '10'）。数字以外を含む番号も数字部分を数値として比べる
const naturalCollator = new Intl.Collator('ja', { numeric: true })

/** ブースの並び: display_code の自然順 → 同番号はブース名順。display_code が null のブースは末尾でブース名順。 */
export function compareBooths(a: BoothGroup, b: BoothGroup): number {
  if (a.display_code !== null && b.display_code === null) return -1
  if (a.display_code === null && b.display_code !== null) return 1
  if (a.display_code !== null && b.display_code !== null) {
    const c = naturalCollator.compare(a.display_code, b.display_code)
    if (c !== 0) return c
  }
  return naturalCollator.compare(a.booth_name, b.booth_name)
}

const byEmail = (a: ExhibitorItem, b: ExhibitorItem) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)

/** 一覧の行（出展者 × 紐付きブース。紐付きなしは booth_id=null）をブース単位にまとめて並べる。 */
export function groupExhibitorsByBooth(rows: ExhibitorListRow[]): {
  booths: BoothGroup[]
  unassigned: ExhibitorItem[]
} {
  const boothMap = new Map<string, BoothGroup>()
  const assignedUsers = new Set<string>()
  const allUsers = new Map<string, ExhibitorItem>()

  for (const r of rows) {
    const item: ExhibitorItem = {
      user_id: r.user_id,
      email: r.email,
      display_name: r.display_name ?? null,
      created_at: `${String(r.created_at).replace(' ', 'T')}Z`,
    }
    allUsers.set(r.user_id, item)
    if (r.booth_id === null || r.booth_name === null) continue
    let group = boothMap.get(r.booth_id)
    if (!group) {
      group = { booth_id: r.booth_id, booth_name: r.booth_name, display_code: r.display_code ?? null, exhibitors: [] }
      boothMap.set(r.booth_id, group)
    }
    group.exhibitors.push(item)
    assignedUsers.add(r.user_id)
  }

  const booths = [...boothMap.values()].sort(compareBooths)
  for (const g of booths) g.exhibitors.sort(byEmail)
  const unassigned = [...allUsers.values()].filter((u) => !assignedUsers.has(u.user_id)).sort(byEmail)
  return { booths, unassigned }
}

class RoleChangeConflict extends Error {}

const INSERT_EXHIBITOR_BOOTH_SQL = 'INSERT INTO exhibitor_booths (user_id, booth_id) VALUES (?, ?)'

export async function adminExhibitorRoutes(app: FastifyInstance) {
  const pre = [requireManager, requireEventMatchesJwt]
  const readPre = [requireStaff, requireEventMatchesJwt]

  app.get<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/exhibitors',
    { preHandler: readPre },
    async (req, reply) => {
      // 別イベントのブースへの紐付け（本来ありえない）は b.id が null になり、紐付きなし扱いになる
      const [rows] = await app.db.query(
        `SELECT u.id AS user_id, u.email, u.display_name, u.created_at,
                b.id AS booth_id, b.name AS booth_name, b.display_code
         FROM users u
         LEFT JOIN exhibitor_booths eb ON eb.user_id = u.id
         LEFT JOIN booths b ON b.id = eb.booth_id AND b.event_id = u.event_id
         WHERE u.event_id = ? AND u.role = 'exhibitor'`,
        [req.params.event_id],
      )
      return sendOk(reply, groupExhibitorsByBooth(rows as ExhibitorListRow[]))
    },
  )

  app.patch<{ Params: { event_id: string; user_id: string } }>(
    '/admin/events/:event_id/users/:user_id/role',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = roleChangeBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const { event_id: eventId, user_id: userId } = req.params
      const body = parsed.data

      const [userRows] = await app.db.query(
        'SELECT id, email, role FROM users WHERE id = ? AND event_id = ? LIMIT 1',
        [userId, eventId],
      )
      const target = (userRows as { id: string; email: string; role: string | null }[])[0]
      if (!target) {
        return sendFail(reply, 404, 'NOT_FOUND', 'ユーザーが見つかりません')
      }
      const currentRole = target.role ?? 'participant'
      if (currentRole !== 'participant' && currentRole !== 'exhibitor') {
        return sendFail(reply, 409, 'CONFLICT', '運営アカウントのロールは変更できません')
      }
      const fromRole = body.role === 'exhibitor' ? 'participant' : 'exhibitor'
      if (currentRole !== fromRole) {
        return sendFail(
          reply, 409, 'CONFLICT',
          body.role === 'exhibitor' ? '参加者のみ出展者に変更できます' : '出展者のみ参加者に変更できます',
        )
      }

      let boothIds: string[] = []
      if (body.role === 'exhibitor') {
        boothIds = [...new Set(body.booth_ids)]
        const placeholders = boothIds.map(() => '?').join(',')
        const [boothRows] = await app.db.query(
          `SELECT id FROM booths WHERE event_id = ? AND id IN (${placeholders})`,
          [eventId, ...boothIds],
        )
        if ((boothRows as unknown[]).length !== boothIds.length) {
          return sendFail(reply, 404, 'NOT_FOUND', 'ブースが見つかりません')
        }
      }

      const conn = await app.db.getConnection?.()
      try {
        const run = async (db: DbClient | DbConnection) => {
          if (body.role === 'exhibitor') {
            await promoteToExhibitor(db, userId, boothIds)
          } else {
            await demoteToParticipant(db, userId)
          }
        }
        if (conn) {
          await conn.beginTransaction()
          try {
            await run(conn)
            await conn.commit()
          } catch (e) {
            await conn.rollback()
            throw e
          }
        } else {
          await run(app.db)
        }
      } catch (e) {
        if (e instanceof RoleChangeConflict) {
          return sendFail(reply, 409, 'CONFLICT', 'ロールが同時に変更されました。画面を更新してください')
        }
        req.log.error(e, 'role change failed')
        return sendFail(reply, 500, 'INTERNAL_ERROR', 'ロールの変更に失敗しました')
      } finally {
        conn?.release()
      }

      await insertAuditLog(app.db, {
        eventId,
        actorId: req.jwtUser!.sub,
        actorRole: 'manager',
        action: 'user.role_change',
        targetType: 'user',
        targetId: userId,
        detail: {
          email: target.email,
          from: fromRole,
          to: body.role,
          ...(body.role === 'exhibitor' ? { booth_ids: boothIds } : {}),
        },
      })

      return sendOk(reply, { user_id: userId, role: body.role })
    },
  )

  app.post<{ Params: { event_id: string } }>(
    '/admin/events/:event_id/exhibitors/bulk',
    { preHandler: pre },
    async (req, reply) => {
      const parsed = bulkBody.safeParse(req.body)
      if (!parsed.success) {
        return sendFail(reply, 422, 'VALIDATION_ERROR', '入力が不正です')
      }
      const { event_id: eventId } = req.params
      const { accounts } = parsed.data

      // 前処理（一括）: 当該イベントの全ブースを Map 化（行ごとに存在確認クエリを撃たない）
      const [boothRows] = await app.db.query('SELECT id, name FROM booths WHERE event_id = ?', [
        eventId,
      ])
      const boothMap = new Map(
        (boothRows as { id: string; name: string }[]).map((b) => [b.id, b.name]),
      )

      const results: RowResult[] = []
      const seen = new Set<string>()

      // トランザクション対応（ローカル mysql2）の場合のみ conn を保持。
      // さくらプロキシ（getConnection 非実装）では undefined のまま順次実行 + 補償削除にフォールバックする（F8）。
      const conn = await app.db.getConnection?.()

      try {
        for (let index = 0; index < accounts.length; index++) {
          const item = accounts[index]
          const email = item.email.toLowerCase()
          const boothId = item.booth_id

          // リクエスト内で (email, booth_id) が重複する行は2件目以降を行エラーに
          const dupKey = `${email}\0${boothId}`
          if (seen.has(dupKey)) {
            results.push({
              index,
              email,
              booth_id: boothId,
              status: 'error',
              error: {
                code: 'VALIDATION_ERROR',
                message: 'リクエスト内でメールアドレスとブースの組み合わせが重複しています',
              },
            })
            continue
          }
          seen.add(dupKey)

          if (!boothMap.has(boothId)) {
            results.push({
              index,
              email,
              booth_id: boothId,
              status: 'error',
              error: { code: 'NOT_FOUND', message: 'ブースが見つかりません' },
            })
            continue
          }

          // INSERT 前 SELECT（ADR 0001: さくらプロキシは重複キーエラーを 500 に潰すため）
          const [existingRows] = await app.db.query(
            'SELECT id, role FROM users WHERE event_id = ? AND email = ? LIMIT 1',
            [eventId, email],
          )
          const existing = (existingRows as ExistingUserRow[])[0]

          if (!existing) {
            const result = await createExhibitor(app, conn, {
              index,
              email,
              boothId,
              password: item.password,
              displayName: item.display_name ?? email,
              eventId,
            })
            results.push(result)
            continue
          }

          if (existing.role === 'participant') {
            const result = await promoteParticipant(app, conn, {
              index,
              email,
              boothId,
              userId: existing.id,
            })
            results.push(result)
            continue
          }

          if (existing.role === 'exhibitor') {
            const result = await linkExistingExhibitor(app, {
              index,
              email,
              boothId,
              userId: existing.id,
            })
            results.push(result)
            continue
          }

          // manager / viewer / admin（旧値含む）: スタッフ降格事故の防止
          results.push({
            index,
            email,
            booth_id: boothId,
            status: 'error',
            error: {
              code: 'CONFLICT',
              message: '運営スタッフには出展者ロールを付与できません',
            },
          })
        }
      } finally {
        conn?.release()
      }

      const summary = {
        total: accounts.length,
        created: results.filter((r) => r.status === 'created').length,
        updated: results.filter((r) => r.status === 'updated').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        failed: results.filter((r) => r.status === 'error').length,
      }

      await insertAuditLog(app.db, {
        eventId,
        actorId: req.jwtUser!.sub,
        actorRole: 'manager',
        action: 'exhibitor.bulk_register',
        targetType: 'user',
        detail: summary,
      })

      return sendOk(reply, { summary, results })
    },
  )
}

/** 新規ユーザーを role='exhibitor' で作成し、exhibitor_booths に紐付ける。 */
async function createExhibitor(
  app: FastifyInstance,
  conn: DbConnection | undefined,
  args: { index: number; email: string; boothId: string; password: string; displayName: string; eventId: string },
): Promise<RowResult> {
  const { index, email, boothId, password, displayName, eventId } = args
  const userId = randomUUID()
  const hash = await bcrypt.hash(password, 10)
  const insertUserSql =
    'INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)'
  const insertUserParams = [userId, eventId, email, hash, displayName, 'exhibitor']

  if (conn) {
    try {
      await conn.beginTransaction()
      await conn.execute(insertUserSql, insertUserParams)
      await conn.execute(INSERT_EXHIBITOR_BOOTH_SQL, [userId, boothId])
      await conn.commit()
      return { index, email, booth_id: boothId, status: 'created', user_id: userId }
    } catch {
      await conn.rollback()
      return {
        index,
        email,
        booth_id: boothId,
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'アカウント作成に失敗しました' },
      }
    }
  }

  // getConnection 非対応（さくらプロキシ）: 順次実行 + 補償削除
  try {
    await app.db.execute(insertUserSql, insertUserParams)
  } catch {
    return {
      index,
      email,
      booth_id: boothId,
      status: 'error',
      error: { code: 'INTERNAL_ERROR', message: 'アカウント作成に失敗しました' },
    }
  }

  try {
    await app.db.execute(INSERT_EXHIBITOR_BOOTH_SQL, [userId, boothId])
    return { index, email, booth_id: boothId, status: 'created', user_id: userId }
  } catch {
    // users を新規 INSERT した後の exhibitor_booths INSERT 失敗時のみ補償削除
    await app.db.execute('DELETE FROM users WHERE id = ?', [userId])
    return {
      index,
      email,
      booth_id: boothId,
      status: 'error',
      error: { code: 'INTERNAL_ERROR', message: 'ブース紐付けに失敗しました' },
    }
  }
}

/** 既存 participant を role='exhibitor' に昇格させ、exhibitor_booths に紐付ける（password_hash は上書きしない）。 */
async function promoteParticipant(
  app: FastifyInstance,
  conn: DbConnection | undefined,
  args: { index: number; email: string; boothId: string; userId: string },
): Promise<RowResult> {
  const { index, email, boothId, userId } = args
  const updateRoleSql = "UPDATE users SET role = 'exhibitor' WHERE id = ?"

  if (conn) {
    try {
      await conn.beginTransaction()
      await conn.execute(updateRoleSql, [userId])
      await conn.execute(INSERT_EXHIBITOR_BOOTH_SQL, [userId, boothId])
      await conn.commit()
      return { index, email, booth_id: boothId, status: 'updated', user_id: userId }
    } catch {
      await conn.rollback()
      return {
        index,
        email,
        booth_id: boothId,
        status: 'error',
        error: { code: 'INTERNAL_ERROR', message: 'ブース紐付けに失敗しました' },
      }
    }
  }

  // getConnection 非対応: UPDATE 系は元 role へ戻す補償は行わず行エラーとして報告のみ
  // （role が exhibitor のまま紐付けゼロでも読み取り専用APIしか開かないため実害なし）
  try {
    await app.db.execute(updateRoleSql, [userId])
    await app.db.execute(INSERT_EXHIBITOR_BOOTH_SQL, [userId, boothId])
    return { index, email, booth_id: boothId, status: 'updated', user_id: userId }
  } catch {
    return {
      index,
      email,
      booth_id: boothId,
      status: 'error',
      error: { code: 'INTERNAL_ERROR', message: 'ブース紐付けに失敗しました' },
    }
  }
}

/** 既存 exhibitor に新しいブースを紐付ける（既に紐付いていれば冪等に skip）。単一 INSERT のみのため conn は不要。 */
async function linkExistingExhibitor(
  app: FastifyInstance,
  args: { index: number; email: string; boothId: string; userId: string },
): Promise<RowResult> {
  const { index, email, boothId, userId } = args
  const [dupRows] = await app.db.query(
    'SELECT 1 FROM exhibitor_booths WHERE user_id = ? AND booth_id = ?',
    [userId, boothId],
  )
  if ((dupRows as unknown[]).length > 0) {
    return { index, email, booth_id: boothId, status: 'skipped', user_id: userId }
  }
  try {
    await app.db.execute(INSERT_EXHIBITOR_BOOTH_SQL, [userId, boothId])
    return { index, email, booth_id: boothId, status: 'updated', user_id: userId }
  } catch {
    return {
      index,
      email,
      booth_id: boothId,
      status: 'error',
      error: { code: 'INTERNAL_ERROR', message: 'ブース紐付けに失敗しました' },
    }
  }
}

type Writer = Pick<DbClient, 'query' | 'execute'>

function affectedRows(result: unknown): number {
  return (result as { affectedRows?: number }).affectedRows ?? 0
}

/** participant → exhibitor。条件付き UPDATE で排他し、既にある紐付けはスキップする（冪等）。パスワードは触らない。 */
async function promoteToExhibitor(db: Writer, userId: string, boothIds: string[]): Promise<void> {
  const [res] = await db.execute(
    "UPDATE users SET role = 'exhibitor' WHERE id = ? AND role = 'participant'",
    [userId],
  )
  if (affectedRows(res) === 0) throw new RoleChangeConflict()

  // INSERT 前 SELECT（ADR 0001: さくらプロキシは重複キーエラーを 500 に潰すため）
  const [linkedRows] = await db.query('SELECT booth_id FROM exhibitor_booths WHERE user_id = ?', [userId])
  const linked = new Set((linkedRows as { booth_id: string }[]).map((r) => r.booth_id))
  for (const boothId of boothIds) {
    if (linked.has(boothId)) continue
    await db.execute(INSERT_EXHIBITOR_BOOTH_SQL, [userId, boothId])
  }
}

/**
 * exhibitor → participant。紐付けをすべて外す。
 * 一括登録の出展者は email_verified_at が NULL のため、そのままだとチェックインが EMAIL_NOT_VERIFIED になる。
 * 運営が本人確認した扱いとして現在時刻を入れる。
 */
async function demoteToParticipant(db: Writer, userId: string): Promise<void> {
  const [res] = await db.execute(
    "UPDATE users SET role = 'participant', email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ? AND role = 'exhibitor'",
    [dateToMysqlUtc(new Date()), userId],
  )
  if (affectedRows(res) === 0) throw new RoleChangeConflict()
  await db.execute('DELETE FROM exhibitor_booths WHERE user_id = ?', [userId])
}
