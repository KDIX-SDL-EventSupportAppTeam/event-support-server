import type { DbClient } from '../../db/client.js'

/**
 * 参加ボーナスマスに入れるブースを選定する。
 *
 * docs/.sdd/03-card-lifecycle/signup.md / docs/.sdd/09-open-questions/open-questions.md Q-4
 * TODO(Q-4): 最終的な選定規則は未決定。以下は「暫定」実装であり、差し替え前提で
 * この1関数に切り出してある。事前アンケート回答を使う案(a)・カバレッジ配分案(b)・
 * 完全ランダム案(c) のいずれを採るかは未決定のため、実装しない。
 *
 * 既定実装（暫定）:
 *   1. is_active=1 のブースを候補にする
 *   2. そのイベントでの現時点の訪問者数が少ない順に並べ、上位30%からランダムに1件選ぶ
 *   3. 候補が0件なら is_active=1 の全ブースからランダム
 *
 * 例外を投げてはならない（E6: 事前アンケート未回答でも必ず値を返す）。
 * 呼び出し側で候補が本当に0件（ブースが1つも無い）の場合のみ null を返す。
 */
export async function pickSignupBonusBooth(
  db: DbClient,
  eventId: string,
  _userId: string,
): Promise<string | null> {
  try {
    const [rows] = await db.query(
      `SELECT b.id,
              (SELECT COUNT(*) FROM check_ins ci
               JOIN users u ON u.id = ci.user_id
               WHERE ci.booth_id = b.id AND ci.event_id = ? AND u.role = 'participant') AS visitors
       FROM booths b
       WHERE b.event_id = ? AND b.is_active = 1
       ORDER BY visitors ASC, RAND()`,
      [eventId, eventId],
    )
    const candidates = (rows as { id: string; visitors: number }[]).map((r) => r.id)
    if (!candidates.length) return null

    const bottomCount = Math.max(1, Math.ceil(candidates.length * 0.3))
    const pool = candidates.slice(0, bottomCount)
    return pool[Math.floor(Math.random() * pool.length)] ?? candidates[0]!
  } catch {
    // E6: 例外を投げてはならない。呼び出し側で null をハンドリングする。
    return null
  }
}
