import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sendFail, sendOk } from '../../../lib/response.js'
import { requireManager, requireEventMatchesJwt } from '../../../plugins/auth.js'
import { insertAuditLog } from '../../../lib/audit.js'
import type { DbConnection } from '../../../db/client.js'

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

const INSERT_EXHIBITOR_BOOTH_SQL = 'INSERT INTO exhibitor_booths (user_id, booth_id) VALUES (?, ?)'

export async function adminExhibitorRoutes(app: FastifyInstance) {
  const pre = [requireManager, requireEventMatchesJwt]

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
