import { randomUUID } from 'node:crypto'
import type { DbClient } from '../../db/client.js'
import { utcMysqlNow } from '../datetime.js'
import { pickPreSurveyBoothWithCandidates } from './pickPreSurveyBooth.js'
import { CENTER_POSITIONS } from './unlockPairs.js'

export const ALL_POSITIONS: readonly number[] = Array.from({ length: 16 }, (_, i) => i)

/** 事前推薦マスの位置。カード生成時に唯一 is_revealed=1 になり得るマス。 */
const PRESURVEY_POSITION = 5

export type BingoCardRow = { id: string }

/**
 * カードを読むだけ。無ければ null。
 * 副作用が要らない参照（ガチャのコイン枚数など）はこちらを使う。
 */
export async function findCard(db: DbClient, eventId: string, userId: string): Promise<BingoCardRow | null> {
  const [rows] = await db.query('SELECT id FROM bingo_cards WHERE event_id = ? AND user_id = ? LIMIT 1', [
    eventId,
    userId,
  ])
  const row = (rows as { id: string }[])[0]
  return row ? { id: row.id } : null
}

/**
 * カードの get-or-create。参加者が初めてカードを要求した時に呼ぶ。
 * docs/specs/bingo-dynamic-unlock/03-card-lifecycle/signup.md
 *
 * - INSERT 前に SELECT で存在確認する。競合で2本目が走った場合も
 *   `ON DUPLICATE KEY UPDATE` で例外にせず、既存カードを読み直して返す。
 *   `catch (err.code === 'ER_DUP_ENTRY')` に頼らないのは、さくらプロキシが
 *   重複キーを code の無い 500 に潰すため（ADR 0001）。例外で分岐する実装は
 *   本番経路でだけ 500 に化ける
 * - bingo_cells が未作成なら16行まとめて作る
 * - position 5 は事前推薦マス。決まらなければ booth_id=NULL, is_revealed=0 のままにする（E1/E3）
 *
 * カードの現在の姿は bingo_cells から導出する（D-8）。bingo_cards.status は持たない。
 */
export async function ensureCard(db: DbClient, eventId: string, userId: string): Promise<BingoCardRow> {
  let card = await findCard(db, eventId, userId)

  if (!card) {
    await db.execute(
      `INSERT INTO bingo_cards (id, event_id, user_id) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE event_id = event_id`,
      [randomUUID(), eventId, userId],
    )
    // 自分の INSERT が無視された（＝競合に負けた）可能性があるため、id は必ず読み直す
    card = await findCard(db, eventId, userId)
    if (!card) throw new Error('ビンゴカードの作成に失敗しました')
  }

  const [countRows] = await db.query('SELECT COUNT(*) AS c FROM bingo_cells WHERE card_id = ?', [card.id])
  const existingCells = Number((countRows as { c: number }[])[0]?.c ?? 0)
  if (existingCells === 0) {
    await createCells(db, eventId, userId, card.id)
  }

  return card
}

async function createCells(db: DbClient, eventId: string, userId: string, cardId: string): Promise<void> {
  // E1/E3: pickPreSurveyBoothWithCandidates は例外を投げない。事前アンケート未回答でもカード生成は必ず成功する。
  const { chosen: preSurveyBoothId, candidateBoothIds } = await pickPreSurveyBoothWithCandidates(
    db,
    eventId,
    userId,
  )
  const now = utcMysqlNow()

  const values: unknown[] = []
  const placeholders: string[] = []
  for (const position of ALL_POSITIONS) {
    const isCenter = CENTER_POSITIONS.includes(position)
    const zone = isCenter ? 'CENTER' : 'OUTER'
    const isPreSurveyCell = position === PRESURVEY_POSITION && preSurveyBoothId !== null

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

  // uq_cell_card_position の競合 = 別リクエストが先に16行作成済み。その場合は何も起きない
  // （ADR 0001 により、重複を例外として捕捉することはできない）
  await db.execute(
    `INSERT INTO bingo_cells
       (id, card_id, position, zone, booth_id, is_revealed, is_achieved, source, assigned_at)
     VALUES ${placeholders.join(',')}
     ON DUPLICATE KEY UPDATE card_id = card_id`,
    values,
  )

  if (!preSurveyBoothId) return

  // 競合に負けていれば position 5 に載っているのは相手が選んだブース。
  // 自分の候補ではなく「実際にカードへ載ったブース」を記録する
  // （そうしないと recommendation_scores がカードに存在しないブースを指す）。
  const assignedBoothId = await readPreSurveyBoothId(db, cardId)
  if (!assignedBoothId) return

  await recordPreSurveyUnlockEvent(db, eventId, cardId, userId, assignedBoothId, candidateBoothIds)
}

/** カードに実際に載っている事前推薦ブース。未割当なら null。 */
async function readPreSurveyBoothId(db: DbClient, cardId: string): Promise<string | null> {
  const [rows] = await db.query('SELECT booth_id FROM bingo_cells WHERE card_id = ? AND position = ? LIMIT 1', [
    cardId,
    PRESURVEY_POSITION,
  ])
  return (rows as { booth_id: string | null }[])[0]?.booth_id ?? null
}

/**
 * 事前推薦も推薦の一種として記録する（signup.md）。
 * unlock_event_id が必要な recommendation_scores に紐づけるため、
 * pair_key='PRESURVEY', line_index=-1, released_positions='5', phase='PRESURVEY' の
 * card_unlock_events を1行作る。
 *
 * D-10: 除外されていない候補ブース全件を recommendation_scores に記録する。
 * `was_assigned = 1` は実際にカードへ載った1件のみ。
 * 冪等性は card_unlock_events の uq_unlock_card_pair（affectedRows===1 のときだけ先へ進む）で担保する。
 */
async function recordPreSurveyUnlockEvent(
  db: DbClient,
  eventId: string,
  cardId: string,
  userId: string,
  assignedBoothId: string,
  candidateBoothIds: string[],
): Promise<void> {
  // ADR 0001: 一意制約に依存する INSERT は事前に SELECT で確認する
  const [existingRows] = await db.query(
    `SELECT id FROM card_unlock_events WHERE card_id = ? AND pair_key = 'PRESURVEY' LIMIT 1`,
    [cardId],
  )
  if ((existingRows as { id: string }[])[0]) return // 既に記録済み

  const [checkinRows] = await db.query(
    `SELECT COUNT(*) AS c FROM check_ins ci
     JOIN users u ON u.id = ci.user_id
     WHERE ci.event_id = ? AND u.role = 'participant'`,
    [eventId],
  )
  const globalCheckinCount = Number((checkinRows as { c: number }[])[0]?.c ?? 0)

  const unlockEventId = randomUUID()
  const [header] = await db.execute(
    `INSERT INTO card_unlock_events
       (id, card_id, pair_key, line_index, released_positions, phase, strategy, decision_table_size, global_checkin_count)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE pair_key = pair_key`,
    [unlockEventId, cardId, 'PRESURVEY', -1, '5', 'PRESURVEY', 'PRESURVEY', null, globalCheckinCount],
  )

  // 競合で無視されたら affectedRows=0。recommendation_scores は一意制約を持たない
  // 追記テーブルなので、ここで止めないと同じ推薦が二重に残る
  if (Number((header as { affectedRows?: number }).affectedRows ?? 0) !== 1) return

  // 除外されていない候補全件を記録する（D-10）。実際にカードへ載ったブースは
  // 候補リストに含まれないことがある（競合の勝者が別プロセスで別候補を選んだ場合）ので必ず足す。
  const boothIds = [...new Set([...candidateBoothIds, assignedBoothId])]
  for (const [i, boothId] of boothIds.entries()) {
    await db.execute(
      `INSERT INTO recommendation_scores
         (id, unlock_event_id, user_id, booth_id, score, rank_in_event, was_assigned, interest_match, attributes, reason_payload)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        randomUUID(),
        unlockEventId,
        userId,
        boothId,
        null,
        i + 1, // 訪問者数の少ない順の並び。assignedBoothId を末尾に足した場合もその順位を振る
        boothId === assignedBoothId ? 1 : 0,
        'UNKNOWN',
        null,
        null,
      ],
    )
  }
}
