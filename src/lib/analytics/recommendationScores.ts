/**
 * 運営分析の推薦集計（マイグレーション09以降）。
 *
 * マイグレーション09で `recommendations` テーブルは廃止され `recommendation_scores` へ移行した。
 * 旧 `recommendations` は「1提示 = 1行」で `offered_booth_ids`(JSON) / `selected_booth_id` を持っていたが、
 * `recommendation_scores` は「候補ブース1件 = 1行」で、採用は `was_assigned` で表す。
 *
 * ⚠️ selected の意味が変わった:
 *   旧: 利用者が提示の中から「選んだ」ブース（`selected_booth_id`）
 *   新: システムがマスに「割り当てた」ブース（`was_assigned = 1`）
 *
 * 応答フィールド名（`recommendation_selected_count` 等）はフロント無改修で復旧させるため据え置くが、
 * 数える対象は「割り当て」になっている。
 * 詳細は docs/specs/migration-09-followup/README.md §4-B と docs/reference/api-endpoints.md。
 *
 * DB に依存しない純関数として切り出してある（docs/rules/testing.md）。
 */

export type RecScoreRow = {
  unlock_event_id: string
  booth_id: string
  was_assigned: number | string
  strategy: string | null
  user_id: string
  created_at: string
}

/** `summary.algorithm` の既定値。解放が1件も無いイベントで使う */
export const DEFAULT_ALGORITHM = 'mab'

/**
 * イベント配下の `recommendation_scores` を引く SQL。
 * `recommendation_scores` に `event_id` 列は無いため `card_unlock_events` → `bingo_cards` を JOIN する。
 * **`users.event_id` では絞らない**（出展者・運営アカウントが混ざるため）。
 */
export const REC_SCORE_BY_EVENT_SQL = `
  SELECT rs.unlock_event_id, rs.booth_id, rs.was_assigned, rs.user_id, rs.created_at, cue.strategy
  FROM recommendation_scores rs
  INNER JOIN card_unlock_events cue ON cue.id = rs.unlock_event_id
  INNER JOIN bingo_cards        bc  ON bc.id  = cue.card_id
  WHERE bc.event_id = ?`

/** `was_assigned` は TINYINT(1)。ドライバによって文字列で返り得るので正規化する */
export function isAssigned(wasAssigned: number | string): boolean {
  return (Number(wasAssigned) || 0) === 1
}

export type RecommendationAggregate = {
  /** ブースが候補に挙がった行数 */
  boothOfferedCount: Record<string, number>
  /** ブースが割り当てられた行数 */
  boothSelectedCount: Record<string, number>
  selectedCount: number
  openCount: number
  algorithm: string
  total: number
}

export function aggregateRecommendations(rows: RecScoreRow[]): RecommendationAggregate {
  const boothOfferedCount: Record<string, number> = {}
  const boothSelectedCount: Record<string, number> = {}
  let selectedCount = 0
  let openCount = 0
  // strategy は解放イベント単位の属性なので、候補行数ではなく解放イベント数で数える
  // （候補が多い解放1回が、候補の少ない解放多数に勝ってしまわないように）
  const strategyByUnlockEvent = new Map<string, string>()

  for (const row of rows) {
    boothOfferedCount[row.booth_id] = (boothOfferedCount[row.booth_id] ?? 0) + 1
    if (isAssigned(row.was_assigned)) {
      selectedCount++
      boothSelectedCount[row.booth_id] = (boothSelectedCount[row.booth_id] ?? 0) + 1
    } else {
      openCount++
    }
    if (row.strategy) strategyByUnlockEvent.set(row.unlock_event_id, row.strategy)
  }

  const strategyTally: Record<string, number> = {}
  for (const strategy of strategyByUnlockEvent.values()) {
    strategyTally[strategy] = (strategyTally[strategy] ?? 0) + 1
  }

  // summary.algorithm は card_unlock_events.strategy の最頻値。
  // 同数のときは名前順で先に来るものを選び、実行ごとに結果が揺れないようにする。
  let algorithm = DEFAULT_ALGORITHM
  let bestTally = 0
  for (const [strategy, count] of Object.entries(strategyTally).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (count > bestTally) {
      bestTally = count
      algorithm = strategy
    }
  }

  return {
    boothOfferedCount,
    boothSelectedCount,
    selectedCount,
    openCount,
    algorithm,
    total: rows.length,
  }
}
