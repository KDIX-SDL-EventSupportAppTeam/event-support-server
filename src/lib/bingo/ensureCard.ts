import { randomUUID } from 'node:crypto'
import type { DbClient } from '../../db/client.js'
import { utcMysqlNow } from '../datetime.js'
import { pickSignupBonusBooth } from './pickSignupBonusBooth.js'

/** 中央2x2の position（行優先 0..15）。docs/.sdd/01-concept/glossary.md */
export const CENTER_POSITIONS: readonly number[] = [5, 6, 9, 10]
export const ALL_POSITIONS: readonly number[] = Array.from({ length: 16 }, (_, i) => i)

export type BingoCardRow = {
  id: string
  status: 'CENTER_ONLY' | 'UNLOCKED'
  unlockedAt: string | null
}

async function findCard(db: DbClient, eventId: string, userId: string): Promise<BingoCardRow | null> {
  const [rows] = await db.query(
    'SELECT id, status, unlocked_at FROM bingo_cards WHERE event_id = ? AND user_id = ? LIMIT 1',
    [eventId, userId],
  )
  const row = (rows as { id: string; status: 'CENTER_ONLY' | 'UNLOCKED'; unlocked_at: string | null }[])[0]
  if (!row) return null
  return { id: row.id, status: row.status, unlockedAt: row.unlocked_at }
}

/**
 * カードの get-or-create。サインアップ時、または参加者が初めてカードを要求した時に呼ぶ。
 * docs/.sdd/03-card-lifecycle/signup.md
 *
 * - INSERT 前に SELECT で存在確認する。競合で2行目の INSERT が失敗した場合は
 *   エラーにせず既存カードを読み直して返す（さくらプロキシは重複キーを 500 に潰すため）。
 * - bingo_cells が未作成なら16行まとめて作る。参加ボーナスは中央4マスから
 *   ランダムに1つ選び、達成済みで配る。
 */
export async function ensureCard(db: DbClient, eventId: string, userId: string): Promise<BingoCardRow> {
  let card = await findCard(db, eventId, userId)

  if (!card) {
    const id = randomUUID()
    try {
      await db.execute(
        `INSERT INTO bingo_cards (id, event_id, user_id, status) VALUES (?,?,?,'CENTER_ONLY')`,
        [id, eventId, userId],
      )
      card = { id, status: 'CENTER_ONLY', unlockedAt: null }
    } catch (e: unknown) {
      const err = e as { code?: string }
      if (err.code !== 'ER_DUP_ENTRY') throw e
      card = await findCard(db, eventId, userId)
      if (!card) throw e
    }
  }

  const [countRows] = await db.query('SELECT COUNT(*) AS c FROM bingo_cells WHERE card_id = ?', [card.id])
  const existingCells = Number((countRows as { c: number }[])[0]?.c ?? 0)
  if (existingCells === 0) {
    await createCells(db, eventId, userId, card.id)
  }

  return card
}

async function createCells(db: DbClient, eventId: string, userId: string, cardId: string): Promise<void> {
  const bonusPosition = CENTER_POSITIONS[Math.floor(Math.random() * CENTER_POSITIONS.length)]!
  // E6: pickSignupBonusBooth は例外を投げない。事前アンケート未回答でもカード生成は必ず成功する。
  const bonusBoothId = await pickSignupBonusBooth(db, eventId, userId)
  const now = utcMysqlNow()

  const values: unknown[] = []
  const placeholders: string[] = []
  for (const position of ALL_POSITIONS) {
    const isCenter = CENTER_POSITIONS.includes(position)
    const zone = isCenter ? 'CENTER' : 'OUTER'
    const isBonus = position === bonusPosition
    const state = isBonus ? 'ACHIEVED' : isCenter ? 'EMPTY' : 'LOCKED'
    const source = isBonus ? 'SIGNUP_BONUS' : null
    const boothId = isBonus ? bonusBoothId : null
    const assignedAt = isBonus ? now : null
    const achievedAt = isBonus ? now : null

    placeholders.push('(?,?,?,?,?,?,?,?,?)')
    values.push(randomUUID(), cardId, position, zone, boothId, state, source, assignedAt, achievedAt)
  }

  try {
    await db.execute(
      `INSERT INTO bingo_cells
         (id, card_id, position, zone, booth_id, state, source, assigned_at, achieved_at)
       VALUES ${placeholders.join(',')}`,
      values,
    )
  } catch (e: unknown) {
    // uq_cell_card_position の競合 = 別リクエストが先に16行作成済み。読み直しは呼び出し側が行う。
    const err = e as { code?: string }
    if (err.code !== 'ER_DUP_ENTRY') throw e
  }
}
