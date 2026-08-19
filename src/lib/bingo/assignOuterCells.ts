import { randomUUID } from 'node:crypto'
import type { AppConfig } from '../../config.js'
import type { DbClient } from '../../db/client.js'
import { utcMysqlNow } from '../datetime.js'
import { callRecommender } from './recommenderClient.js'
import { pickFallbackBoothIds } from './fallback.js'

type LockedCell = { id: string; position: number }
type CenterCell = { booth_id: string | null; source: string | null }

/**
 * 外側12マスへブースを確定する。解放処理・self-healing の両方から呼ばれる共通処理。
 * docs/.sdd/03-card-lifecycle/unlock.md / docs/.sdd/05-recommender/fallback.md
 *
 * 呼び出し前提: このカードの外側マス書き込みに対する排他は呼び出し側が確保していること
 * （解放処理は条件付き UPDATE の affectedRows、self-healing は「LOCKED が残っている」検知が
 *  そのまま冪等な条件になる＝二重に埋まることはない。state='LOCKED' の cell だけを対象にする）。
 *
 * @returns 実際に埋めたマス数
 */
export async function assignOuterCells(
  db: DbClient,
  config: AppConfig,
  eventId: string,
  userId: string,
  cardId: string,
): Promise<number> {
  const [lockedRows] = await db.query(
    `SELECT id, position FROM bingo_cells WHERE card_id = ? AND state = 'LOCKED' ORDER BY position ASC`,
    [cardId],
  )
  const lockedCells = lockedRows as LockedCell[]
  if (!lockedCells.length) return 0

  const [centerRows] = await db.query(
    `SELECT booth_id, source FROM bingo_cells WHERE card_id = ? AND zone = 'CENTER' ORDER BY position ASC`,
    [cardId],
  )
  const centerCells = centerRows as CenterCell[]
  const centerBoothIds = centerCells.map((c) => c.booth_id).filter((b): b is string => !!b)

  const [checkinRows] = await db.query(
    `SELECT DISTINCT booth_id FROM check_ins WHERE user_id = ? AND event_id = ?`,
    [userId, eventId],
  )
  const visitedBoothIds = (checkinRows as { booth_id: string }[]).map((r) => r.booth_id)

  const [inactiveRows] = await db.query(
    `SELECT id FROM booths WHERE event_id = ? AND is_active = 0`,
    [eventId],
  )
  const inactiveBoothIds = (inactiveRows as { id: string }[]).map((r) => r.id)

  const excludeSet = new Set<string>([...centerBoothIds, ...visitedBoothIds, ...inactiveBoothIds])

  const cellCount = lockedCells.length

  // 推薦サービス呼び出し用の visited_booths（参加ボーナスを含む）
  const [visitedForPayload] = await db.query(
    `SELECT ci.booth_id, ci.visit_order, bc.source, br.rating
     FROM bingo_cells bc
     LEFT JOIN check_ins ci ON ci.cell_id = bc.id
     LEFT JOIN booth_ratings br ON br.checkin_id = ci.id
     WHERE bc.card_id = ? AND bc.zone = 'CENTER'
     ORDER BY bc.position ASC`,
    [cardId],
  )
  const visitedBooths = (
    visitedForPayload as {
      booth_id: string | null
      visit_order: number | null
      source: string | null
      rating: number | null
    }[]
  )
    .filter((r) => r.booth_id)
    .map((r, idx) => ({
      booth_id: r.booth_id as string,
      order: r.visit_order ?? idx,
      source: (r.source ?? 'FREE_VISIT') as 'SIGNUP_BONUS' | 'FREE_VISIT',
      rating: r.rating ?? null,
    }))

  const globalCheckinCount = await countGlobalCheckins(db, eventId)

  const recommended = await callRecommender(config, {
    event_id: eventId,
    user_id: userId,
    visited_booths: visitedBooths,
    rating_scale: config.ratingScale,
    pre_survey: null, // Q-2: 既存 survey_questions/user_survey_answers を使う。ここでは通し口のみ
    exclude_booth_ids: [...excludeSet],
    cell_count: cellCount,
  })

  const assignments: { boothId: string; strategy: string; score: number | null; reason: unknown }[] = []
  const seen = new Set(excludeSet)

  if (recommended?.length) {
    // 検証: 存在しない/is_active=0/重複を除去する（推薦サービスを信用しない）
    const candidateIds = [...new Set(recommended.map((c) => c.booth_id))].filter((id) => !seen.has(id))
    const validBoothIds = candidateIds.length ? await filterActiveBoothIds(db, eventId, candidateIds) : new Set<string>()
    for (const cell of recommended) {
      if (assignments.length >= cellCount) break
      if (seen.has(cell.booth_id)) continue
      if (!validBoothIds.has(cell.booth_id)) continue
      seen.add(cell.booth_id)
      assignments.push({ boothId: cell.booth_id, strategy: cell.strategy, score: cell.score, reason: cell.reason })
    }
  }

  if (assignments.length < cellCount) {
    const remaining = cellCount - assignments.length
    const fallbackIds = await pickFallbackBoothIds(db, eventId, [...seen], remaining)
    for (const boothId of fallbackIds) {
      assignments.push({
        boothId,
        strategy: 'FALLBACK_COVERAGE',
        score: null,
        reason: null,
      })
    }
  }

  const now = utcMysqlNow()
  const cellUpdates: { id: string; boothId: string | null; source: string | null }[] = []
  const logRows: { cellId: string; strategy: string; score: number | null; reason: unknown }[] = []

  lockedCells.forEach((cell, idx) => {
    const assignment = assignments[idx]
    if (assignment) {
      cellUpdates.push({ id: cell.id, boothId: assignment.boothId, source: assignment.strategy === 'FALLBACK_COVERAGE' ? 'RECOMMEND' : 'RECOMMEND' })
      logRows.push({
        cellId: cell.id,
        strategy: assignment.strategy,
        score: assignment.score,
        reason:
          assignment.strategy === 'FALLBACK_COVERAGE'
            ? { kind: 'fallback', visitors: null }
            : assignment.reason,
      })
    } else {
      // E13: 候補が不足。LOCKED のまま放置せず EMPTY/booth_id=NULL にする
      cellUpdates.push({ id: cell.id, boothId: null, source: null })
    }
  })

  await updateOuterCellsBatch(db, cellUpdates, now)

  if (logRows.length) {
    await insertAssignmentLogs(db, logRows, globalCheckinCount)
  }

  return cellUpdates.filter((c) => c.boothId).length
}

async function countGlobalCheckins(db: DbClient, eventId: string): Promise<number> {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS c FROM check_ins ci
     JOIN users u ON u.id = ci.user_id
     WHERE ci.event_id = ? AND u.role = 'participant'`,
    [eventId],
  )
  return Number((rows as { c: number }[])[0]?.c ?? 0)
}

async function filterActiveBoothIds(db: DbClient, eventId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const placeholders = ids.map(() => '?').join(',')
  const [rows] = await db.query(
    `SELECT id FROM booths WHERE event_id = ? AND is_active = 1 AND id IN (${placeholders})`,
    [eventId, ...ids],
  )
  return new Set((rows as { id: string }[]).map((r) => r.id))
}

async function updateOuterCellsBatch(
  db: DbClient,
  updates: { id: string; boothId: string | null; source: string | null }[],
  now: string,
): Promise<void> {
  if (!updates.length) return
  const boothCase: string[] = []
  const sourceCase: string[] = []
  const assignedCase: string[] = []
  const ids: string[] = []
  const params: unknown[] = []

  for (const u of updates) {
    boothCase.push('WHEN ? THEN ?')
    params.push(u.id, u.boothId)
  }
  for (const u of updates) {
    sourceCase.push('WHEN ? THEN ?')
    params.push(u.id, u.source)
  }
  for (const u of updates) {
    assignedCase.push('WHEN ? THEN ?')
    params.push(u.id, u.boothId ? now : null)
  }
  for (const u of updates) ids.push(u.id)

  const idPlaceholders = ids.map(() => '?').join(',')
  await db.execute(
    `UPDATE bingo_cells
     SET booth_id = CASE id ${boothCase.join(' ')} END,
         state = 'EMPTY',
         source = CASE id ${sourceCase.join(' ')} END,
         assigned_at = CASE id ${assignedCase.join(' ')} END
     WHERE id IN (${idPlaceholders}) AND state = 'LOCKED'`,
    [...params, ...ids],
  )
}

async function insertAssignmentLogs(
  db: DbClient,
  rows: { cellId: string; strategy: string; score: number | null; reason: unknown }[],
  globalCheckinCount: number,
): Promise<void> {
  const placeholders: string[] = []
  const params: unknown[] = []
  for (const r of rows) {
    placeholders.push('(?,?,?,?,?,?)')
    params.push(
      randomUUID(),
      r.cellId,
      r.strategy,
      r.score,
      r.reason !== null && r.reason !== undefined ? JSON.stringify(r.reason) : null,
      globalCheckinCount,
    )
  }
  await db.execute(
    `INSERT INTO cell_assignment_logs (id, cell_id, strategy, score, reason_payload, global_checkin_count)
     VALUES ${placeholders.join(',')}`,
    params,
  )
}
