import { randomUUID } from 'node:crypto'
import type { DbClient } from '../../db/client.js'
import { utcMysqlNow } from '../datetime.js'
import { pickPreSurveyBooth } from './pickPreSurveyBooth.js'
import { CENTER_POSITIONS } from './unlockPairs.js'

export const ALL_POSITIONS: readonly number[] = Array.from({ length: 16 }, (_, i) => i)

export type BingoCardRow = { id: string }

async function findCard(db: DbClient, eventId: string, userId: string): Promise<BingoCardRow | null> {
  const [rows] = await db.query('SELECT id FROM bingo_cards WHERE event_id = ? AND user_id = ? LIMIT 1', [
    eventId,
    userId,
  ])
  const row = (rows as { id: string }[])[0]
  return row ? { id: row.id } : null
}

/**
 * カードの get-or-create。サインアップ時、または参加者が初めてカードを要求した時のいずれか早い方に呼ぶ。
 * docs/specs/bingo-dynamic-unlock/03-card-lifecycle/signup.md
 *
 * - INSERT 前に SELECT で存在確認する。競合で2行目の INSERT が失敗した場合は
 *   エラーにせず既存カードを読み直して返す（さくらプロキシは重複キーを 500 に潰すため。ADR 0001）
 * - bingo_cells が未作成なら16行まとめて作る
 * - position 5 は事前推薦マス。決まらなければ booth_id=NULL, is_revealed=0 のままにする（E1/E3）
 *
 * カードの現在の姿は bingo_cells から導出する（D-8）。bingo_cards.status は持たない。
 */
export async function ensureCard(db: DbClient, eventId: string, userId: string): Promise<BingoCardRow> {
  let card = await findCard(db, eventId, userId)

  if (!card) {
    const id = randomUUID()
    try {
      await db.execute(`INSERT INTO bingo_cards (id, event_id, user_id) VALUES (?,?,?)`, [id, eventId, userId])
      card = { id }
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
  // E1/E3: pickPreSurveyBooth は例外を投げない。事前アンケート未回答でもカード生成は必ず成功する。
  const preSurveyBoothId = await pickPreSurveyBooth(db, eventId, userId)
  const now = utcMysqlNow()

  const values: unknown[] = []
  const placeholders: string[] = []
  for (const position of ALL_POSITIONS) {
    const isCenter = CENTER_POSITIONS.includes(position)
    const zone = isCenter ? 'CENTER' : 'OUTER'
    const isPreSurveyCell = position === 5 && preSurveyBoothId !== null

    placeholders.push('(?,?,?,?,?,?,?,?,?)')
    values.push(
      randomUUID(),
      cardId,
      position,
      zone,
      isPreSurveyCell ? preSurveyBoothId : null,
      isPreSurveyCell ? 1 : 0, // is_revealed
      0, // is_achieved（参加ボーナスは廃止。D-1）
      isPreSurveyCell ? 'PRESURVEY' : null,
      isPreSurveyCell ? now : null, // assigned_at
    )
  }

  try {
    await db.execute(
      `INSERT INTO bingo_cells
         (id, card_id, position, zone, booth_id, is_revealed, is_achieved, source, assigned_at)
       VALUES ${placeholders.join(',')}`,
      values,
    )
  } catch (e: unknown) {
    // uq_cell_card_position の競合 = 別リクエストが先に16行作成済み。読み直しは呼び出し側の責務。
    const err = e as { code?: string }
    if (err.code !== 'ER_DUP_ENTRY') throw e
    return
  }

  if (preSurveyBoothId) {
    await recordPreSurveyUnlockEvent(db, eventId, cardId, userId, preSurveyBoothId)
  }
}

/**
 * 事前推薦も推薦の一種として記録する（signup.md）。
 * unlock_event_id が必要な recommendation_scores に紐づけるため、
 * pair_key='PRESURVEY', line_index=-1, released_positions='5', phase='PRESURVEY' の
 * card_unlock_events を1行作る。
 *
 * pickPreSurveyBooth は候補全件のスコアを返さないため、ここでは選ばれた1件のみを
 * was_assigned=1 で記録する（D-10 が求める「全候補」までは満たせていない。判断メモ:
 * event-support-server 側の実装ドキュメントに記載）。
 */
async function recordPreSurveyUnlockEvent(
  db: DbClient,
  eventId: string,
  cardId: string,
  userId: string,
  boothId: string,
): Promise<void> {
  const [checkinRows] = await db.query(
    `SELECT COUNT(*) AS c FROM check_ins ci
     JOIN users u ON u.id = ci.user_id
     WHERE ci.event_id = ? AND u.role = 'participant'`,
    [eventId],
  )
  const globalCheckinCount = Number((checkinRows as { c: number }[])[0]?.c ?? 0)

  const unlockEventId = randomUUID()
  try {
    await db.execute(
      `INSERT INTO card_unlock_events
         (id, card_id, pair_key, line_index, released_positions, phase, strategy, decision_table_size, global_checkin_count)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [unlockEventId, cardId, 'PRESURVEY', -1, '5', 'PRESURVEY', 'PRESURVEY', null, globalCheckinCount],
    )
  } catch (e: unknown) {
    const err = e as { code?: string }
    if (err.code === 'ER_DUP_ENTRY') return // 既に記録済み
    throw e
  }

  await db.execute(
    `INSERT INTO recommendation_scores
       (id, unlock_event_id, user_id, booth_id, score, rank_in_event, was_assigned, interest_match, attributes, reason_payload)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), unlockEventId, userId, boothId, null, 1, 1, 'UNKNOWN', null, null],
  )
}
