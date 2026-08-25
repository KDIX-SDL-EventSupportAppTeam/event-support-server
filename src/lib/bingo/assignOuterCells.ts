import { randomUUID } from 'node:crypto'
import type { AppConfig } from '../../config.js'
import type { DbClient } from '../../db/client.js'
import { utcMysqlNow } from '../datetime.js'
import { callRecommender, type RecommendCellsResponse, type VisitedBoothPayload } from './recommenderClient.js'
import { deriveFallbackCandidates, pickTopFallbackBoothIds } from './fallback.js'
import { determinePhase } from './phases.js'

export type OuterCellTarget = { cellId: string; position: number }

/** 1回の解放で成立した1ペアぶんの割当対象。unlockEventId は card_unlock_events.id。 */
export type PairAssignmentContext = {
  unlockEventId: string
  pairKey: string
  targets: readonly OuterCellTarget[] // 通常2件
}

type Assignment = { boothId: string | null; strategy: string; score: number | null; reason: unknown }

/**
 * 推薦結果（またはフォールバック）を、実際に指定された外周マスへ割り当てる。
 * docs/specs/bingo-dynamic-unlock/03-card-lifecycle/unlock.md 手順3〜5
 *
 * 複数ペアが同時に成立した場合は、要求件数をまとめて1回の推薦リクエストで処理する
 * （要求件数 = 新規ペア数 × 2）。呼び出し前提: card_unlock_events への INSERT で
 * 解放の権利を取得済みであること（このモジュール自体は排他を取らない）。
 */
export async function assignOuterCellsForPairs(
  db: DbClient,
  config: AppConfig,
  eventId: string,
  userId: string,
  cardId: string,
  pairs: readonly PairAssignmentContext[],
  opts: { isSelfHeal?: boolean; globalCheckinCount?: number } = {},
): Promise<{ releasedPositions: number[] }> {
  const allTargets = pairs.flatMap((p) => p.targets)
  if (!allTargets.length) return { releasedPositions: [] }

  const excludeSet = await buildExcludeSet(db, eventId, userId, cardId)
  const cellCount = allTargets.length

  const visitedBooths = await buildVisitedBoothsPayload(db, cardId, config.ratingScale)
  const preSurvey = await buildPreSurveyPayload(db, eventId, userId)
  const candidateBooths = await buildCandidateBooths(db, eventId, excludeSet)

  const response = candidateBooths.length
    ? await callRecommender(config, {
        event_id: eventId,
        user_id: userId,
        cell_count: cellCount,
        visited_booths: visitedBooths,
        pre_survey: preSurvey,
        exclude_booth_ids: [...excludeSet],
        candidate_booths: candidateBooths,
      })
    : null

  const activeCandidateIds = new Map(candidateBooths.map((c) => [c.booth_id, c.category_id]))

  const seen = new Set(excludeSet)
  const assignedBoothIds: string[] = []
  // scores を保存する候補一覧（was_assigned は後で確定する）
  const scoreRows: {
    boothId: string
    score: number | null
    rank: number | null
    interestMatch: string
    attributes: unknown
    reason: unknown
  }[] = []

  let phase: string
  let decisionTableSize: number | null
  let strategyForRecommended = 'RECOMMEND'

  if (response) {
    phase = response.phase
    decisionTableSize = response.decisionTableSize

    for (const s of response.scores) {
      if (!activeCandidateIds.has(s.booth_id)) continue // E11: 存在しない/非活性は捨てる
      scoreRows.push({
        boothId: s.booth_id,
        score: s.score,
        rank: s.rank,
        interestMatch: s.interest_match,
        attributes: s.attributes,
        reason: s.reason,
      })
    }

    for (const a of response.assigned) {
      if (assignedBoothIds.length >= cellCount) break
      if (seen.has(a.booth_id)) continue // E10: 重複・除外済みは弾く
      if (!activeCandidateIds.has(a.booth_id)) continue // E11
      seen.add(a.booth_id)
      assignedBoothIds.push(a.booth_id)
    }
  } else {
    phase = determinePhase(0)
    decisionTableSize = null
    strategyForRecommended = 'FALLBACK_COVERAGE'
  }

  // 不足分をフォールバックで補う（推薦が使えない/不足のとき常にここを通る）。
  // C-5: candidateBooths が既に「除外後の有効ブース＋参加者訪問者数」を持っているので、
  // フォールバック規則（訪問者数の少ない順・同数はランダム）をそこから導出し、SQL 往復を1回減らす。
  const fallbackCandidates = deriveFallbackCandidates(candidateBooths, seen)
  // recommendation_scores には除外されていない全候補を記録する（D-10）。
  // 推薦が使えた場合でも、推薦が返さなかった候補分をフォールバック値で補って記録する。
  for (const c of fallbackCandidates) {
    if (scoreRows.some((r) => r.boothId === c.boothId)) continue
    scoreRows.push({ boothId: c.boothId, score: null, rank: null, interestMatch: 'UNKNOWN', attributes: null, reason: null })
  }

  if (assignedBoothIds.length < cellCount) {
    const remaining = cellCount - assignedBoothIds.length
    const fallbackIds = pickTopFallbackBoothIds(
      fallbackCandidates.filter((c) => !seen.has(c.boothId)),
      remaining,
    )
    for (const id of fallbackIds) {
      seen.add(id)
      assignedBoothIds.push(id)
    }
  }

  // 割当を position 順のターゲットへ配る（推薦側の順序に意味を持たせない）
  const assignmentByCell = new Map<string, Assignment>()
  let cursor = 0
  for (const target of allTargets) {
    const boothId = assignedBoothIds[cursor] ?? null
    cursor += 1
    if (boothId) {
      const isRecommended = response?.assigned.some((a) => a.booth_id === boothId) ?? false
      assignmentByCell.set(target.cellId, {
        boothId,
        strategy: isRecommended ? strategyForRecommended : 'FALLBACK_COVERAGE',
        score: response?.scores.find((s) => s.booth_id === boothId)?.score ?? null,
        reason: response?.scores.find((s) => s.booth_id === boothId)?.reason ?? null,
      })
    } else {
      // E7: 候補が足りない。is_revealed=1, booth_id=NULL のまま解放済み扱いにする
      assignmentByCell.set(target.cellId, { boothId: null, strategy: 'INSUFFICIENT_CANDIDATES', score: null, reason: null })
    }
  }

  const now = utcMysqlNow()
  await updateOuterCellsBatch(db, allTargets, assignmentByCell, now)

  // C-1: 呼び出し側が既に数えているならその値を使い、同一リクエスト内の二重集計を避ける
  const globalCheckinCount = opts.globalCheckinCount ?? (await countGlobalCheckins(db, eventId))

  // A-2: recommendation_scores は UNIQUE(unlock_event_id, booth_id)。さくらプロキシは重複キーを
  // 500 に潰して ER_DUP_ENTRY を捕捉できないため、INSERT 前に SELECT で既存行を確認する
  // （自己修復の同時実行で同じ unlock_event を2本が処理しうる）。
  const alreadyScored = await findUnlockEventIdsWithScores(
    db,
    pairs.map((p) => p.unlockEventId),
  )
  const scoreInserts: { unlockEventId: string; assignedBoothIds: ReadonlySet<string> }[] = []
  const metaUpdates: { unlockEventId: string; strategy: string }[] = []

  for (const pair of pairs) {
    const assignedBoothIdsForPair = new Set(
      pair.targets.map((t) => assignmentByCell.get(t.cellId)?.boothId).filter((b): b is string => !!b),
    )
    if (!alreadyScored.has(pair.unlockEventId)) {
      scoreInserts.push({ unlockEventId: pair.unlockEventId, assignedBoothIds: assignedBoothIdsForPair })
    }
    const pairStrategies = pair.targets.map((t) => assignmentByCell.get(t.cellId)?.strategy)
    const strategy = opts.isSelfHeal
      ? 'SELF_HEAL'
      : pairStrategies.some((s) => s === 'RECOMMEND')
        ? 'RECOMMEND'
        : 'FALLBACK_COVERAGE'
    metaUpdates.push({ unlockEventId: pair.unlockEventId, strategy })
  }

  // C-2: 全ペア分の scores を1回の複数行 INSERT にまとめる（contract.md「1回の複数行 INSERT」）
  await insertRecommendationScores(db, { userId, scoreRows, pairs: scoreInserts })
  // C-3: ペアごとの UPDATE を CASE 式で1回にまとめる
  await markUnlockEventMetaBatch(db, metaUpdates, phase, decisionTableSize, globalCheckinCount)

  return { releasedPositions: allTargets.map((t) => t.position) }
}

async function buildExcludeSet(db: DbClient, eventId: string, userId: string, cardId: string): Promise<Set<string>> {
  // C-4: カード掲載・訪問済み・非活性の3クエリを UNION で1往復にまとめる（UNION が重複も畳む）
  const [rows] = await db.query(
    `SELECT booth_id FROM bingo_cells WHERE card_id = ? AND booth_id IS NOT NULL
     UNION
     SELECT booth_id FROM check_ins WHERE user_id = ? AND event_id = ?
     UNION
     SELECT id FROM booths WHERE event_id = ? AND is_active = 0`,
    [cardId, userId, eventId, eventId],
  )
  return new Set((rows as { booth_id: string | null }[]).map((r) => r.booth_id).filter((b): b is string => !!b))
}

async function buildVisitedBoothsPayload(
  db: DbClient,
  cardId: string,
  ratingScale: number,
): Promise<VisitedBoothPayload[]> {
  // A-1: 解放済みだが未訪問（is_achieved=0）のマスを「訪問済みブース」として送らない。
  // contract.md は visited_booths を「訪問順」と定義しているので ci.visit_order で並べる。
  const [rows] = await db.query(
    `SELECT ci.booth_id, ci.visit_order, bc.source, br.rating
     FROM bingo_cells bc
     LEFT JOIN check_ins ci ON ci.cell_id = bc.id
     LEFT JOIN booth_ratings br ON br.checkin_id = ci.id
     WHERE bc.card_id = ? AND bc.booth_id IS NOT NULL AND bc.is_achieved = 1
     ORDER BY ci.visit_order ASC`,
    [cardId],
  )
  return (
    rows as { booth_id: string | null; visit_order: number | null; source: string | null; rating: number | null }[]
  )
    .filter((r) => r.booth_id)
    .map((r, idx) => ({
      booth_id: r.booth_id as string,
      order: r.visit_order ?? idx,
      source: (r.source === 'PRESURVEY' ? 'PRESURVEY' : 'FREE_VISIT') as 'PRESURVEY' | 'FREE_VISIT',
      rating: r.rating ?? null,
      rating_scale: ratingScale,
    }))
}

async function buildPreSurveyPayload(
  db: DbClient,
  eventId: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const [rows] = await db.query(
    `SELECT age_range, occupation, industry, custom_answers
     FROM user_survey_answers WHERE event_id = ? AND user_id = ? LIMIT 1`,
    [eventId, userId],
  )
  const row = (rows as Record<string, unknown>[])[0]
  if (!row) return null
  // A-3: contract.md のリクエスト例は平坦なオブジェクト。custom_answers を展開して
  // interest_categories などをトップレベルへ出す（入れ子のままだと推薦側が読めない）。
  const { custom_answers: customAnswers, ...rest } = row
  return { ...rest, ...parseCustomAnswers(customAnswers) }
}

/** custom_answers は JSON 型でもドライバによっては文字列で返る。失敗しても例外を投げない。 */
function parseCustomAnswers(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return {}
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

async function buildCandidateBooths(
  db: DbClient,
  eventId: string,
  excludeSet: ReadonlySet<string>,
): Promise<{ booth_id: string; category_id: string | null; visitor_count: number }[]> {
  const excludeList = excludeSet.size ? [...excludeSet] : ['']
  const placeholders = excludeList.map(() => '?').join(',')
  const [rows] = await db.query(
    `SELECT b.id, b.category_id,
            (SELECT COUNT(*) FROM check_ins ci
             JOIN users u ON u.id = ci.user_id
             WHERE ci.booth_id = b.id AND ci.event_id = ? AND u.role = 'participant') AS visitor_count
     FROM booths b
     WHERE b.event_id = ? AND b.is_active = 1 AND b.id NOT IN (${placeholders})`,
    [eventId, eventId, ...excludeList],
  )
  return (rows as { id: string; category_id: string | null; visitor_count: number }[]).map((r) => ({
    booth_id: r.id,
    category_id: r.category_id,
    visitor_count: Number(r.visitor_count ?? 0),
  }))
}

async function updateOuterCellsBatch(
  db: DbClient,
  targets: readonly OuterCellTarget[],
  assignmentByCell: Map<string, Assignment>,
  now: string,
): Promise<void> {
  if (!targets.length) return
  const boothCase: string[] = []
  const sourceCase: string[] = []
  const assignedCase: string[] = []
  const params: unknown[] = []

  for (const t of targets) {
    const a = assignmentByCell.get(t.cellId)!
    boothCase.push('WHEN ? THEN ?')
    params.push(t.cellId, a.boothId)
  }
  for (const t of targets) {
    const a = assignmentByCell.get(t.cellId)!
    sourceCase.push('WHEN ? THEN ?')
    params.push(t.cellId, a.boothId ? 'RECOMMEND' : null)
  }
  for (const t of targets) {
    assignedCase.push('WHEN ? THEN ?')
    params.push(t.cellId, now)
  }
  const ids = targets.map((t) => t.cellId)
  const idPlaceholders = ids.map(() => '?').join(',')

  await db.execute(
    `UPDATE bingo_cells
     SET booth_id = CASE id ${boothCase.join(' ')} END,
         is_revealed = 1,
         source = CASE id ${sourceCase.join(' ')} END,
         assigned_at = CASE id ${assignedCase.join(' ')} END
     WHERE id IN (${idPlaceholders}) AND is_revealed = 0`,
    [...params, ...ids],
  )
}

/** A-2: 既に recommendation_scores を持つ unlock_event_id を返す（INSERT 前の SELECT 確認）。 */
async function findUnlockEventIdsWithScores(db: DbClient, unlockEventIds: readonly string[]): Promise<Set<string>> {
  if (!unlockEventIds.length) return new Set()
  const placeholders = unlockEventIds.map(() => '?').join(',')
  const [rows] = await db.query(
    `SELECT DISTINCT unlock_event_id FROM recommendation_scores WHERE unlock_event_id IN (${placeholders})`,
    [...unlockEventIds],
  )
  return new Set((rows as { unlock_event_id: string }[]).map((r) => r.unlock_event_id))
}

async function insertRecommendationScores(
  db: DbClient,
  opts: {
    userId: string
    scoreRows: {
      boothId: string
      score: number | null
      rank: number | null
      interestMatch: string
      attributes: unknown
      reason: unknown
    }[]
    pairs: readonly { unlockEventId: string; assignedBoothIds: ReadonlySet<string> }[]
  },
): Promise<void> {
  if (!opts.scoreRows.length || !opts.pairs.length) return
  const placeholders: string[] = []
  const params: unknown[] = []
  for (const pair of opts.pairs) {
    for (const r of opts.scoreRows) {
      placeholders.push('(?,?,?,?,?,?,?,?,?,?)')
      params.push(
        randomUUID(),
        pair.unlockEventId,
        opts.userId,
        r.boothId,
        r.score,
        r.rank,
        pair.assignedBoothIds.has(r.boothId) ? 1 : 0,
        r.interestMatch,
        r.attributes !== null && r.attributes !== undefined ? JSON.stringify(r.attributes) : null,
        r.reason !== null && r.reason !== undefined ? JSON.stringify(r.reason) : null,
      )
    }
  }
  await db.execute(
    `INSERT INTO recommendation_scores
       (id, unlock_event_id, user_id, booth_id, score, rank_in_event, was_assigned, interest_match, attributes, reason_payload)
     VALUES ${placeholders.join(',')}`,
    params,
  )
}

/**
 * C-3: 複数ペアの card_unlock_events を1回の UPDATE で確定させる。
 * strategy はペアごとに違いうるので CASE 式にする（updateOuterCellsBatch と同じ流儀）。
 */
async function markUnlockEventMetaBatch(
  db: DbClient,
  updates: readonly { unlockEventId: string; strategy: string }[],
  phase: string,
  decisionTableSize: number | null,
  globalCheckinCount: number,
): Promise<void> {
  if (!updates.length) return
  const strategyCase: string[] = []
  const params: unknown[] = [phase, decisionTableSize, globalCheckinCount]
  for (const u of updates) {
    strategyCase.push('WHEN ? THEN ?')
    params.push(u.unlockEventId, u.strategy)
  }
  const ids = updates.map((u) => u.unlockEventId)
  const idPlaceholders = ids.map(() => '?').join(',')
  await db.execute(
    `UPDATE card_unlock_events
     SET phase = ?, decision_table_size = ?, global_checkin_count = ?,
         strategy = CASE id ${strategyCase.join(' ')} END
     WHERE id IN (${idPlaceholders})`,
    [...params, ...ids],
  )
}

export async function countGlobalCheckins(db: DbClient, eventId: string): Promise<number> {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS c FROM check_ins ci
     JOIN users u ON u.id = ci.user_id
     WHERE ci.event_id = ? AND u.role = 'participant'`,
    [eventId],
  )
  return Number((rows as { c: number }[])[0]?.c ?? 0)
}
