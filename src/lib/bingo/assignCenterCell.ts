import type { DbClient } from '../../db/client.js'
import { utcMysqlNow } from '../datetime.js'

const MAX_RETRIES = 3

/**
 * 後出し割当。中央マスのうち booth_id IS NULL のものを position 昇順で1つ選び、
 * 今チェックインしたブースを割り当てる。docs/specs/bingo-dynamic-unlock/03-card-lifecycle/checkin.md 分岐2
 *
 * トランザクション・行ロックが使えないため（D-15）、条件付き UPDATE の
 * affectedRows で直列化する。0 なら他リクエストが先に埋めたので取り直して再試行する。
 *
 * @returns 割り当てたマスの id/position。中央に空きが無ければ null（＝実質すでに中央完成）。
 */
export async function assignCenterCell(
  db: DbClient,
  cardId: string,
  boothId: string,
): Promise<{ cellId: string; position: number } | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const [rows] = await db.query(
      `SELECT id, position FROM bingo_cells
       WHERE card_id = ? AND zone = 'CENTER' AND booth_id IS NULL
       ORDER BY position ASC LIMIT 1`,
      [cardId],
    )
    const cell = (rows as { id: string; position: number }[])[0]
    if (!cell) return null

    const now = utcMysqlNow()
    const [result] = await db.execute(
      `UPDATE bingo_cells
       SET booth_id = ?, is_revealed = 1, is_achieved = 1, source = 'FREE_VISIT',
           assigned_at = ?, achieved_at = ?
       WHERE id = ? AND booth_id IS NULL`,
      [boothId, now, now, cell.id],
    )
    const affected = (result as { affectedRows?: number }).affectedRows ?? 0
    if (affected === 1) {
      return { cellId: cell.id, position: cell.position }
    }
    // affectedRows = 0: 他リクエストが先に埋めた。取り直して再試行する。
  }
  return null
}

/** カードの中央4マスが全て達成済みかを判定する。 */
export async function isCenterComplete(db: DbClient, cardId: string): Promise<boolean> {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS c FROM bingo_cells WHERE card_id = ? AND zone = 'CENTER' AND is_achieved = 0`,
    [cardId],
  )
  const remaining = Number((rows as { c: number }[])[0]?.c ?? 0)
  return remaining === 0
}

/** カードの達成済み中央 position の集合を返す（unlock.ts の純関数呼び出しに渡す）。 */
export async function getAchievedCenterPositions(db: DbClient, cardId: string): Promise<Set<number>> {
  const [rows] = await db.query(
    `SELECT position FROM bingo_cells WHERE card_id = ? AND zone = 'CENTER' AND is_achieved = 1`,
    [cardId],
  )
  return new Set((rows as { position: number }[]).map((r) => r.position))
}
