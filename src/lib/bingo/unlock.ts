import type { AppConfig } from '../../config.js'
import type { DbClient } from '../../db/client.js'
import { utcMysqlNow } from '../datetime.js'
import { assignOuterCells } from './assignOuterCells.js'

/**
 * 解放処理（本機能の中核）。docs/.sdd/03-card-lifecycle/unlock.md
 *
 * トリガー: 中央4マスが全て ACHIEVED になった瞬間。チェックイン処理と同一リクエスト内で
 * 同期的に実行する。冪等性は条件付き UPDATE の affectedRows で判定する（D-7。
 * SELECT ... FOR UPDATE はプロキシ経由のため使えない）。
 *
 * socket.io の送出は呼び出し側（checkins.ts）が行う。ここは DB 処理のみに責務を絞る。
 */
export async function unlockCard(
  db: DbClient,
  config: AppConfig,
  eventId: string,
  userId: string,
  cardId: string,
): Promise<{ unlocked: boolean; unlockedAt: string | null }> {
  const now = utcMysqlNow()
  const [result] = await db.execute(
    `UPDATE bingo_cards SET status = 'UNLOCKED', unlocked_at = ?, updated_at = ?
     WHERE id = ? AND status = 'CENTER_ONLY'`,
    [now, now, cardId],
  )
  const affected = (result as { affectedRows?: number }).affectedRows ?? 0
  if (affected !== 1) {
    // 既に他のリクエストが解放済み。何もせずカードの現状を返す（演出の二重発火を防ぐ）
    return { unlocked: false, unlockedAt: null }
  }

  // 推薦サービス呼び出し＋フォールバックで外側12マスを確定する。
  // 失敗しても（DB エラー等）カードは既に UNLOCKED であり、
  // GET /bingo/card 側の self-healing が LOCKED 残存を検知して修復する（E14）。
  await assignOuterCells(db, config, eventId, userId, cardId)

  return { unlocked: true, unlockedAt: `${now.replace(' ', 'T')}Z` }
}

/**
 * self-healing（E14 / docs/.sdd/05-recommender/fallback.md）。
 * status='UNLOCKED' なのに state='LOCKED' のマスが残っている場合、その場でフォールバック
 * 割当を実行して修復する。解放処理の途中で DB エラーが起きた場合の回復経路。
 */
export async function healUnlockedCardIfNeeded(
  db: DbClient,
  config: AppConfig,
  eventId: string,
  userId: string,
  cardId: string,
): Promise<void> {
  const [rows] = await db.query(`SELECT COUNT(*) AS c FROM bingo_cells WHERE card_id = ? AND state = 'LOCKED'`, [
    cardId,
  ])
  const lockedCount = Number((rows as { c: number }[])[0]?.c ?? 0)
  if (lockedCount > 0) {
    await assignOuterCells(db, config, eventId, userId, cardId)
  }
}
