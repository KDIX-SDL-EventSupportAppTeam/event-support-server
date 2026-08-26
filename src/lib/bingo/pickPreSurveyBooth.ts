import type { DbClient } from '../../db/client.js'

/**
 * 事前推薦マス（position 5）に入れるブースを選定する。
 * docs/specs/bingo-dynamic-unlock/03-card-lifecycle/signup.md
 *
 * 「ベタな推薦」でよい。DRSA は通さない（イベント開始直後は行動データが無いため）。
 *
 * 規則:
 *   1. user_survey_answers.custom_answers.interest_categories（category_id の配列）を読む
 *   2. 一致するカテゴリの is_active=1 ブースを候補にする
 *   3. そのイベントでの訪問者数が少ない順に並べ、上位30%からランダムに1件選ぶ
 *   4. 候補が0件（未回答・該当ブースなし）なら null を返す
 *
 * この関数は例外を投げてはならない（E1/E3: 未回答・該当なしでもカード生成は必ず成功する）。
 */
export async function pickPreSurveyBooth(db: DbClient, eventId: string, userId: string): Promise<string | null> {
  try {
    const interestCategoryIds = await readInterestCategories(db, eventId, userId)
    if (!interestCategoryIds.length) return null

    const placeholders = interestCategoryIds.map(() => '?').join(',')
    const [rows] = await db.query(
      `SELECT b.id,
              (SELECT COUNT(*) FROM check_ins ci
               JOIN users u ON u.id = ci.user_id
               WHERE ci.booth_id = b.id AND ci.event_id = ? AND u.role = 'participant') AS visitors
       FROM booths b
       WHERE b.event_id = ? AND b.is_active = 1 AND b.category_id IN (${placeholders})
       ORDER BY visitors ASC, RAND()`,
      [eventId, eventId, ...interestCategoryIds],
    )
    const candidates = (rows as { id: string; visitors: number }[]).map((r) => r.id)
    if (!candidates.length) return null

    const bottomCount = Math.max(1, Math.ceil(candidates.length * 0.3))
    const pool = candidates.slice(0, bottomCount)
    return pool[Math.floor(Math.random() * pool.length)] ?? candidates[0]!
  } catch {
    // 例外を投げてはならない（E1/E3）。呼び出し側で null をハンドリングする。
    return null
  }
}

async function readInterestCategories(db: DbClient, eventId: string, userId: string): Promise<string[]> {
  const [rows] = await db.query(
    `SELECT custom_answers FROM user_survey_answers WHERE event_id = ? AND user_id = ? LIMIT 1`,
    [eventId, userId],
  )
  const row = (rows as { custom_answers: unknown }[])[0]
  if (!row) return []
  const raw = row.custom_answers
  const parsed: unknown = typeof raw === 'string' ? safeJsonParse(raw) : raw
  if (!parsed || typeof parsed !== 'object') return []
  const list = (parsed as Record<string, unknown>).interest_categories
  if (!Array.isArray(list)) return []
  return list.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
