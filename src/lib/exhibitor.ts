import type { DbClient } from '../db/client.js'

/** 出展者が当該イベントの booth を担当しているか。担当していれば booth 名を返し、それ以外は null。
 *  users.role と exhibitor_booths の両方を1クエリで確認する（#52 横断決定: 認可はDB参照）。 */
export async function assertExhibitorOwnsBooth(
  db: DbClient, userId: string, eventId: string, boothId: string,
): Promise<{ id: string; name: string } | null> {
  const [rows] = await db.query(
    `SELECT b.id, b.name
     FROM exhibitor_booths eb
     JOIN booths b ON b.id = eb.booth_id
     JOIN users  u ON u.id = eb.user_id
     WHERE eb.user_id = ? AND eb.booth_id = ? AND b.event_id = ? AND u.role = 'exhibitor'
     LIMIT 1`,
    [userId, boothId, eventId],
  )
  return (rows as { id: string; name: string }[])[0] ?? null
}

/**
 * 担当ブース一覧（frontend #43 の切替ボタン表示・ダッシュボードのブース選択用）。
 * role が exhibitor でなくてもエラーにせず空で返す（フロントが1コードパスで判定できるように）。
 * exhibitor でない場合は booths クエリ自体を撃たない。
 */
export async function getExhibitorBoothIds(
  db: DbClient, userId: string, eventId: string,
): Promise<{ isExhibitor: boolean; booths: { id: string; name: string }[] }> {
  const [roleRows] = await db.query(
    'SELECT role FROM users WHERE id = ? AND event_id = ? LIMIT 1',
    [userId, eventId],
  )
  const role = (roleRows as { role: string }[])[0]?.role
  if (role !== 'exhibitor') {
    return { isExhibitor: false, booths: [] }
  }
  const [boothRows] = await db.query(
    `SELECT b.id, b.name FROM exhibitor_booths eb
     JOIN booths b ON b.id = eb.booth_id
     WHERE eb.user_id = ? AND b.event_id = ?
     ORDER BY b.name ASC`,
    [userId, eventId],
  )
  return { isExhibitor: true, booths: boothRows as { id: string; name: string }[] }
}
