import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../../src/config.js'
import type { DbClient } from '../../src/db/client.js'
import { processCenterAchievement, healUnlockedCardIfNeeded } from '../../src/lib/bingo/unlock.js'
import { CENTER_POSITIONS, OUTER_POSITIONS, pairDefinitionByKey } from '../../src/lib/bingo/unlockPairs.js'

const config: AppConfig = {
  port: 3000,
  databaseUrl: 'mysql://test',
  sakuraProxyUrl: undefined,
  sakuraProxyKey: undefined,
  jwtSecret: 'secret',
  webhookApiKey: '',
  recommenderUrl: '', // 未設定 → 常にフォールバックへ（05-recommender/contract.md）
  recommenderTimeoutMs: 1000,
  checkinCooldownSec: 0,
  ratingScale: 4,
  corsOrigin: 'http://localhost:5173',
  adminRegistrationKey: 'k',
  frontendBaseUrl: undefined,
  organizerRegistrationKey: undefined,
  organizerSignupMode: 'invite',
  smtpHost: undefined,
  smtpPort: 587,
  smtpUser: undefined,
  smtpPass: undefined,
  mailFrom: 'from@example.com',
}

type Cell = {
  id: string
  card_id: string
  position: number
  zone: 'CENTER' | 'OUTER'
  booth_id: string | null
  is_revealed: number
  is_achieved: number
  source: string | null
  visit_order?: number
}
type UnlockEvent = {
  id: string
  card_id: string
  pair_key: string
  line_index: number
  released_positions: string
  phase: string
  strategy: string
  decision_table_size: number | null
  global_checkin_count: number
}
type ScoreRow = { id: string; unlock_event_id: string; booth_id: string; was_assigned: number }
type Booth = { id: string; event_id: string; is_active: number }

/**
 * unlock.ts / assignOuterCells.ts が実際に発行する SQL パターンにのみ対応するインメモリ DB。
 */
function makeTestDb(opts: { cardId: string; cells: Cell[]; boothCount: number; surveyRow?: Record<string, unknown> }) {
  const { cardId, cells } = opts
  const booths: Booth[] = Array.from({ length: opts.boothCount }, (_, i) => ({
    id: `booth-${i}`,
    event_id: 'event-1',
    is_active: 1,
  }))
  const unlockEvents: UnlockEvent[] = []
  const scores: ScoreRow[] = []

  const query = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/SELECT position FROM bingo_cells WHERE card_id = \? AND zone = 'CENTER' AND is_achieved = 1/.test(sql)) {
      const rows = cells.filter((c) => c.zone === 'CENTER' && c.is_achieved === 1).map((c) => ({ position: c.position }))
      return [rows, undefined]
    }
    if (/SELECT pair_key FROM card_unlock_events WHERE card_id = \? AND pair_key <> 'PRESURVEY'/.test(sql)) {
      const [id] = params as [string]
      const rows = unlockEvents.filter((e) => e.card_id === id).map((e) => ({ pair_key: e.pair_key }))
      return [rows, undefined]
    }
    if (/SELECT COUNT\(\*\) AS c FROM check_ins ci\s+JOIN users u/.test(sql)) {
      return [[{ c: 42 }], undefined]
    }
    if (/SELECT id FROM card_unlock_events WHERE card_id = \? AND pair_key = \? LIMIT 1/.test(sql)) {
      const [id, pairKey] = params as [string, string]
      const row = unlockEvents.find((e) => e.card_id === id && e.pair_key === pairKey)
      return [row ? [{ id: row.id }] : [], undefined]
    }
    if (/SELECT id, position FROM bingo_cells WHERE card_id = \? AND zone = 'OUTER'/.test(sql)) {
      const rows = cells.filter((c) => c.zone === 'OUTER').map((c) => ({ id: c.id, position: c.position }))
      return [rows, undefined]
    }
    if (/SELECT position FROM bingo_cells WHERE card_id = \? AND zone = 'OUTER' AND is_revealed = 1/.test(sql)) {
      const rows = cells.filter((c) => c.zone === 'OUTER' && c.is_revealed === 1).map((c) => ({ position: c.position }))
      return [rows, undefined]
    }
    // buildExcludeSet は UNION 1本にまとまっている（C-4）
    if (/SELECT booth_id FROM bingo_cells WHERE card_id = \? AND booth_id IS NOT NULL\s+UNION/.test(sql)) {
      const rows = cells.filter((c) => c.booth_id !== null).map((c) => ({ booth_id: c.booth_id }))
      return [rows, undefined]
    }
    if (/SELECT DISTINCT unlock_event_id FROM recommendation_scores WHERE unlock_event_id IN/.test(sql)) {
      const ids = params as string[]
      const found = [...new Set(scores.filter((s) => ids.includes(s.unlock_event_id)).map((s) => s.unlock_event_id))]
      return [found.map((id) => ({ unlock_event_id: id })), undefined]
    }
    if (/SELECT ci\.booth_id, ci\.visit_order, bc\.source, br\.rating/.test(sql)) {
      // A-1: is_achieved=1 のマスだけを、訪問順（visit_order 昇順）で返す
      const rows = cells
        .filter((c) => c.booth_id !== null && c.is_achieved === 1)
        .map((c, idx) => ({ booth_id: c.booth_id, visit_order: c.visit_order ?? idx, source: c.source, rating: null }))
        .sort((a, b) => (a.visit_order ?? 0) - (b.visit_order ?? 0))
      return [rows, undefined]
    }
    if (/SELECT age_range, occupation, industry, custom_answers\s+FROM user_survey_answers/.test(sql)) {
      return [opts.surveyRow ? [{ ...opts.surveyRow }] : [], undefined]
    }
    // C-6: 未修復のイベントだけを1クエリで引く
    if (/FROM card_unlock_events cue[\s\S]*FIND_IN_SET/.test(sql)) {
      const [id] = params as [string]
      const rows = unlockEvents
        .filter((e) => e.card_id === id && e.pair_key !== 'PRESURVEY')
        .filter((e) =>
          e.released_positions
            .split(',')
            .map((n) => Number(n.trim()))
            .some((pos) => cells.some((c) => c.zone === 'OUTER' && c.position === pos && c.is_revealed === 0)),
        )
        .map((e) => ({ id: e.id, pair_key: e.pair_key, released_positions: e.released_positions }))
      return [rows, undefined]
    }
    if (/SELECT id, position, is_revealed FROM bingo_cells WHERE card_id = \? AND zone = 'OUTER'/.test(sql)) {
      const rows = cells
        .filter((c) => c.zone === 'OUTER')
        .map((c) => ({ id: c.id, position: c.position, is_revealed: c.is_revealed }))
      return [rows, undefined]
    }
    if (/SELECT b\.id, b\.category_id,[\s\S]*FROM booths b\s+WHERE b\.event_id = \? AND b\.is_active = 1 AND b\.id NOT IN/.test(sql)) {
      const excludeList = params.slice(2) as string[]
      const candidates = booths.filter((b) => b.is_active === 1 && !excludeList.includes(b.id))
      return [candidates.map((b) => ({ id: b.id, category_id: null, visitor_count: 0 })), undefined]
    }
    if (/SELECT b\.id, COUNT\(u\.id\) AS visitors\s+FROM booths b/.test(sql)) {
      const excludeList = params.slice(1) as string[]
      const candidates = booths.filter((b) => b.is_active === 1 && !excludeList.includes(b.id))
      return [candidates.map((b) => ({ id: b.id, visitors: 0 })), undefined]
    }
    throw new Error(`unmatched SELECT: ${sql}`)
  }

  const execute = async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    if (/INSERT INTO card_unlock_events/.test(sql)) {
      const [id, cardIdP, pairKey, lineIndex, releasedPositions, phase, strategy, decisionTableSize, globalCheckinCount] =
        params as [string, string, string, number, string, string, string, number | null, number]
      if (unlockEvents.some((e) => e.card_id === cardIdP && e.pair_key === pairKey)) {
        const err = new Error('dup') as Error & { code?: string }
        err.code = 'ER_DUP_ENTRY'
        throw err
      }
      unlockEvents.push({
        id,
        card_id: cardIdP,
        pair_key: pairKey,
        line_index: lineIndex,
        released_positions: releasedPositions,
        phase,
        strategy,
        decision_table_size: decisionTableSize,
        global_checkin_count: globalCheckinCount,
      })
      return [{ affectedRows: 1 }, undefined]
    }
    if (/UPDATE bingo_cells\s+SET booth_id = CASE id/.test(sql)) {
      const n = params.length / 7
      const boothPairs = params.slice(0, n * 2)
      const sourcePairs = params.slice(n * 2, n * 4)
      let affected = 0
      for (let i = 0; i < n; i++) {
        const id = boothPairs[i * 2] as string
        const boothId = boothPairs[i * 2 + 1] as string | null
        const source = sourcePairs[i * 2 + 1] as string | null
        const cell = cells.find((c) => c.id === id)
        if (cell && cell.is_revealed === 0) {
          cell.booth_id = boothId
          cell.is_revealed = 1
          cell.source = source
          affected += 1
        }
      }
      return [{ affectedRows: affected }, undefined]
    }
    if (/INSERT INTO recommendation_scores/.test(sql)) {
      for (let i = 0; i < params.length; i += 10) {
        scores.push({
          id: params[i] as string,
          unlock_event_id: params[i + 1] as string,
          booth_id: params[i + 3] as string,
          was_assigned: params[i + 6] as number,
        })
      }
      return [{ affectedRows: params.length / 10 }, undefined]
    }
    // C-3: CASE 式でまとめた1回の UPDATE
    if (/UPDATE card_unlock_events\s+SET phase = \?, decision_table_size = \?, global_checkin_count = \?,\s+strategy = CASE id/.test(sql)) {
      const [phase, decisionTableSize, globalCheckinCount] = params as [string, number | null, number]
      const rest = params.slice(3)
      const n = rest.length / 3 // (id, strategy) ペア + 末尾の id 一覧
      let affected = 0
      for (let i = 0; i < n; i++) {
        const id = rest[i * 2] as string
        const strategy = rest[i * 2 + 1] as string
        const ev = unlockEvents.find((e) => e.id === id)
        if (ev) {
          ev.phase = phase
          ev.decision_table_size = decisionTableSize
          ev.global_checkin_count = globalCheckinCount
          ev.strategy = strategy
          affected += 1
        }
      }
      return [{ affectedRows: affected }, undefined]
    }
    throw new Error(`unmatched EXECUTE: ${sql}`)
  }

  const db: DbClient = { query, execute, end: async () => {} }
  return { db, cells, unlockEvents, scores, cardId }
}

function buildAllCenterAchievedCard(): Cell[] {
  const cardId = 'card-1'
  const cells: Cell[] = []
  for (let pos = 0; pos < 16; pos++) {
    const isCenter = CENTER_POSITIONS.includes(pos)
    cells.push({
      id: `cell-${pos}`,
      card_id: cardId,
      position: pos,
      zone: isCenter ? 'CENTER' : 'OUTER',
      booth_id: isCenter ? `visited-${pos}` : null,
      is_revealed: isCenter ? 1 : 0,
      is_achieved: isCenter ? 1 : 0,
      source: isCenter ? 'FREE_VISIT' : null,
    })
  }
  return cells
}

describe('processCenterAchievement', () => {
  it('中央4マス完成で6ペア成立し、外周12マスがフォールバックで埋まる（推薦未設定）', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db, unlockEvents, scores } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })

    const result = await processCenterAchievement(db, config, 'event-1', 'user-1', 'card-1')

    expect(result.unlockedPositions.sort((a, b) => a - b)).toEqual([...OUTER_POSITIONS].sort((a, b) => a - b))
    expect(unlockEvents).toHaveLength(6)

    const outerCells = cells.filter((c) => c.zone === 'OUTER')
    expect(outerCells).toHaveLength(12)
    expect(outerCells.every((c) => c.is_revealed === 1)).toBe(true)
    expect(outerCells.every((c) => c.booth_id !== null)).toBe(true)
    // 重複ブースが入らないこと
    const boothIds = outerCells.map((c) => c.booth_id)
    expect(new Set(boothIds).size).toBe(boothIds.length)

    // strategy='FALLBACK_COVERAGE' で記録される
    expect(unlockEvents.every((e) => e.strategy === 'FALLBACK_COVERAGE')).toBe(true)
    expect(unlockEvents.every((e) => e.global_checkin_count === 42)).toBe(true)
    expect(scores.length).toBeGreaterThan(0)
    expect(scores.filter((s) => s.was_assigned === 1)).toHaveLength(12)
  })

  it('冪等性: 同じ状態で2回呼んでも2回目は新規解放が起きない', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db, unlockEvents } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })

    await processCenterAchievement(db, config, 'event-1', 'user-1', 'card-1')
    expect(unlockEvents).toHaveLength(6)

    const second = await processCenterAchievement(db, config, 'event-1', 'user-1', 'card-1')
    expect(second.unlockedPositions).toEqual([])
    expect(unlockEvents).toHaveLength(6) // 増えない
  })

  it('外周マスの達成では解放が一切起きない（中央未達成のまま呼んでも新規ペアなし）', async () => {
    const cells = buildAllCenterAchievedCard()
    // 中央を未達成に戻す
    for (const c of cells) {
      if (c.zone === 'CENTER') {
        c.is_achieved = 0
        c.booth_id = null
      }
    }
    const { db, unlockEvents } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })
    const result = await processCenterAchievement(db, config, 'event-1', 'user-1', 'card-1')
    expect(result.unlockedPositions).toEqual([])
    expect(unlockEvents).toHaveLength(0)
  })

  it('候補ブースが12件に満たない場合、埋められるだけ埋めて残りは is_revealed=1/booth_id=NULL にする（E7）', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db } = makeTestDb({ cardId: 'card-1', cells, boothCount: 5 }) // 候補5件のみ

    const result = await processCenterAchievement(db, config, 'event-1', 'user-1', 'card-1')
    expect(result.unlockedPositions).toHaveLength(12) // 12マス全て is_revealed=1 になる

    const outerCells = cells.filter((c) => c.zone === 'OUTER')
    const filled = outerCells.filter((c) => c.booth_id !== null)
    const empty = outerCells.filter((c) => c.booth_id === null)
    expect(filled).toHaveLength(5)
    expect(empty).toHaveLength(7)
    expect(outerCells.every((c) => c.is_revealed === 1)).toBe(true) // is_revealed=0 のまま放置しない
  })
})

describe('healUnlockedCardIfNeeded（自己修復）', () => {
  it('解放イベントだけ作られてマスが is_revealed=0 のまま残っている場合、修復される', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db, cells: dbCells, unlockEvents, scores } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })

    // 解放イベントだけ作られた壊れた状態を再現（unlock.ts の手順2は成功したが手順4で失敗したケース）
    unlockEvents.push({
      id: 'unlock-evt-1',
      card_id: 'card-1',
      pair_key: '5-6',
      line_index: 1,
      released_positions: '4,7',
      phase: 'COVERAGE',
      strategy: 'PENDING',
      decision_table_size: null,
      global_checkin_count: 10,
    })

    await healUnlockedCardIfNeeded(db, config, 'event-1', 'user-1', 'card-1')

    const cell4 = dbCells.find((c) => c.position === 4)!
    const cell7 = dbCells.find((c) => c.position === 7)!
    expect(cell4.is_revealed).toBe(1)
    expect(cell7.is_revealed).toBe(1)
    expect(cell4.booth_id).not.toBeNull()
    expect(cell7.booth_id).not.toBeNull()

    const updatedEvent = unlockEvents.find((e) => e.id === 'unlock-evt-1')!
    expect(updatedEvent.strategy).toBe('SELF_HEAL')
    expect(scores.some((s) => s.unlock_event_id === 'unlock-evt-1')).toBe(true)
  })

  it('解放イベントが無ければ何もしない', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db, cells: dbCells } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })
    await healUnlockedCardIfNeeded(db, config, 'event-1', 'user-1', 'card-1')
    expect(dbCells.filter((c) => c.zone === 'OUTER' && c.is_revealed === 1)).toHaveLength(0)
  })

  it('3回ぶんの解放イベントすべてが独立して点検される', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db, cells: dbCells, unlockEvents } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })

    unlockEvents.push(
      {
        id: 'evt-1',
        card_id: 'card-1',
        pair_key: '5-6',
        line_index: 1,
        released_positions: '4,7',
        phase: 'COVERAGE',
        strategy: 'PENDING',
        decision_table_size: null,
        global_checkin_count: 1,
      },
      {
        id: 'evt-2',
        card_id: 'card-1',
        pair_key: '9-10',
        line_index: 2,
        released_positions: '8,11',
        phase: 'COVERAGE',
        strategy: 'PENDING',
        decision_table_size: null,
        global_checkin_count: 2,
      },
      {
        id: 'evt-3',
        card_id: 'card-1',
        pair_key: '5-9',
        line_index: 5,
        released_positions: '1,13',
        phase: 'COVERAGE',
        strategy: 'PENDING',
        decision_table_size: null,
        global_checkin_count: 3,
      },
    )

    await healUnlockedCardIfNeeded(db, config, 'event-1', 'user-1', 'card-1')

    for (const pos of [4, 7, 8, 11, 1, 13]) {
      const cell = dbCells.find((c) => c.position === pos)!
      expect(cell.is_revealed).toBe(1)
      expect(cell.booth_id).not.toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// 推薦サービスへ送るペイロード（05-recommender/contract.md）
// ---------------------------------------------------------------------------

const configWithRecommender: AppConfig = { ...config, recommenderUrl: 'http://recommender.test' }

/** fetch を差し替えて、推薦サービスへ送られたリクエストボディを捕まえる。 */
function stubRecommender(): { requests: Record<string, any>[] } {
  const requests: Record<string, any>[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body))
    // assigned/scores は空で返す → 割当はフォールバックが担う（解放は必ず成功させる）
    return {
      ok: true,
      json: async () => ({ phase: 'DRSA', decision_table_size: 7, assigned: [], scores: [] }),
    } as unknown as Response
  })
  return { requests }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('visited_booths ペイロード（A-1）', () => {
  it('解放済みだが未訪問（is_achieved=0）の外周マスを訪問済みブースに含めない', async () => {
    const cells = buildAllCenterAchievedCard()
    // 1回目の解放で position 4,7 に推薦ブースが載った状態（is_revealed=1 / is_achieved=0）
    for (const pos of [4, 7]) {
      const c = cells.find((x) => x.position === pos)!
      c.booth_id = `recommended-${pos}`
      c.is_revealed = 1
      c.is_achieved = 0
      c.source = 'RECOMMEND'
    }
    const { db } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })
    const { requests } = stubRecommender()

    await processCenterAchievement(db, configWithRecommender, 'event-1', 'user-1', 'card-1')

    expect(requests).toHaveLength(1)
    const visitedIds = requests[0]!.visited_booths.map((v: { booth_id: string }) => v.booth_id)
    expect(visitedIds).not.toContain('recommended-4')
    expect(visitedIds).not.toContain('recommended-7')
    // 実際に訪問した中央4マスだけが載る
    expect([...visitedIds].sort()).toEqual(['visited-10', 'visited-5', 'visited-6', 'visited-9'])
    // ただしカードに載っている以上 exclude_booth_ids には残る
    expect(requests[0]!.exclude_booth_ids).toContain('recommended-4')
  })

  it('visited_booths は position 順ではなく訪問順（visit_order 昇順）で並ぶ', async () => {
    const cells = buildAllCenterAchievedCard()
    // position の昇順と訪問順が逆になるように仕込む
    const orders: Record<number, number> = { 5: 4, 6: 3, 9: 2, 10: 1 }
    for (const c of cells) {
      if (c.zone === 'CENTER') c.visit_order = orders[c.position]
    }
    const { db } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })
    const { requests } = stubRecommender()

    await processCenterAchievement(db, configWithRecommender, 'event-1', 'user-1', 'card-1')

    const visited = requests[0]!.visited_booths as { booth_id: string; order: number }[]
    expect(visited.map((v) => v.booth_id)).toEqual(['visited-10', 'visited-9', 'visited-6', 'visited-5'])
    expect(visited.map((v) => v.order)).toEqual([1, 2, 3, 4])
  })
})

describe('pre_survey ペイロード（A-3）', () => {
  it('custom_answers を展開して平坦なオブジェクトで送る（文字列で返っても JSON.parse する）', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db } = makeTestDb({
      cardId: 'card-1',
      cells,
      boothCount: 40,
      surveyRow: {
        age_range: 'twenties',
        occupation: 'student',
        industry: 'it',
        custom_answers: JSON.stringify({ interest_categories: ['cat-a', 'cat-b'], q_free: 'hello' }),
      },
    })
    const { requests } = stubRecommender()

    await processCenterAchievement(db, configWithRecommender, 'event-1', 'user-1', 'card-1')

    expect(requests[0]!.pre_survey).toEqual({
      age_range: 'twenties',
      occupation: 'student',
      industry: 'it',
      interest_categories: ['cat-a', 'cat-b'],
      q_free: 'hello',
    })
    expect(requests[0]!.pre_survey.custom_answers).toBeUndefined()
  })

  it('custom_answers が壊れた文字列でも例外を投げず、他の項目は送られる', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db } = makeTestDb({
      cardId: 'card-1',
      cells,
      boothCount: 40,
      surveyRow: { age_range: 'teens', occupation: null, industry: null, custom_answers: '{ broken json' },
    })
    const { requests } = stubRecommender()

    await processCenterAchievement(db, configWithRecommender, 'event-1', 'user-1', 'card-1')

    expect(requests[0]!.pre_survey).toEqual({ age_range: 'teens', occupation: null, industry: null })
  })

  it('オブジェクトで返る custom_answers もそのまま平坦化する', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db } = makeTestDb({
      cardId: 'card-1',
      cells,
      boothCount: 40,
      surveyRow: {
        age_range: 'thirties',
        occupation: null,
        industry: null,
        custom_answers: { interest_categories: ['cat-x'] },
      },
    })
    const { requests } = stubRecommender()

    await processCenterAchievement(db, configWithRecommender, 'event-1', 'user-1', 'card-1')

    expect(requests[0]!.pre_survey.interest_categories).toEqual(['cat-x'])
  })
})

describe('recommendation_scores の重複防止（A-2）', () => {
  const insertBrokenEvent = async (db: DbClient, id: string) =>
    db.execute(
      `INSERT INTO card_unlock_events
         (id, card_id, pair_key, line_index, released_positions, phase, strategy, decision_table_size, global_checkin_count)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, 'card-1', '5-6', 1, '4,7', 'COVERAGE', 'PENDING', null, 10],
    )

  /**
   * 同一の未修復イベントが二重に処理される状況（GET /bingo/card の二重呼び出し）。
   * 後発は INSERT 前の SELECT で既存 scores を見つけてスキップする。
   * ※本番DBはトランザクションが使えないため、完全同時（両者が INSERT 前に SELECT を終える）
   *   ケースまでは閉じられない。それは card_unlock_events の UNIQUE と同じ割り切り（ADR 0001）。
   */
  it('二重呼び出しで (unlock_event_id, booth_id) を重複 INSERT しない', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db, scores } = makeTestDb({ cardId: 'card-1', cells, boothCount: 20 })
    await insertBrokenEvent(db, 'evt-a')

    await healUnlockedCardIfNeeded(db, config, 'event-1', 'user-1', 'card-1')
    const afterFirst = scores.length
    expect(afterFirst).toBeGreaterThan(0)

    // 先発がマス更新まで終えた直後に後発が同じイベントを掴んだ状態を再現する
    for (const pos of [4, 7]) {
      const c = cells.find((x) => x.position === pos)!
      c.is_revealed = 0
      c.booth_id = null
    }
    await healUnlockedCardIfNeeded(db, config, 'event-1', 'user-1', 'card-1')

    expect(scores.length).toBe(afterFirst) // 増えない
    const keys = scores.map((s) => `${s.unlock_event_id}:${s.booth_id}`)
    expect(new Set(keys).size).toBe(keys.length) // UNIQUE(unlock_event_id, booth_id) に当たらない
  })

  it('修復対象が複数ペアでも scores INSERT は1回、既に scores のあるペアは除かれる', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db, scores } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })
    await insertBrokenEvent(db, 'evt-a') // 5-6 → 4,7
    await db.execute(
      `INSERT INTO card_unlock_events
         (id, card_id, pair_key, line_index, released_positions, phase, strategy, decision_table_size, global_checkin_count)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ['evt-b', 'card-1', '9-10', 2, '8,11', 'COVERAGE', 'PENDING', null, 10],
    )

    await healUnlockedCardIfNeeded(db, config, 'event-1', 'user-1', 'card-1')
    expect(new Set(scores.map((s) => s.unlock_event_id))).toEqual(new Set(['evt-a', 'evt-b']))

    // evt-a のマスだけ戻す → 2回目は evt-a の scores をスキップする
    const before = scores.length
    for (const pos of [4, 7]) {
      const c = cells.find((x) => x.position === pos)!
      c.is_revealed = 0
      c.booth_id = null
    }
    await healUnlockedCardIfNeeded(db, config, 'event-1', 'user-1', 'card-1')
    expect(scores.length).toBe(before)
  })
})

describe('SQL 往復数（C）', () => {
  it('6ペア同時成立でも scores の INSERT と meta の UPDATE は1回ずつにまとまる（C-2/C-3）', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })
    const executed: string[] = []
    const origExecute = db.execute
    db.execute = async (sql: string, params?: unknown[]) => {
      executed.push(sql)
      return origExecute(sql, params as unknown[])
    }

    await processCenterAchievement(db, config, 'event-1', 'user-1', 'card-1')

    expect(executed.filter((s) => /INSERT INTO recommendation_scores/.test(s))).toHaveLength(1)
    expect(executed.filter((s) => /UPDATE card_unlock_events/.test(s))).toHaveLength(1)
  })

  it('修復不要なカードの healUnlockedCardIfNeeded は1クエリで終わる（C-6）', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })
    const queried: string[] = []
    const origQuery = db.query
    db.query = async (sql: string, params?: unknown[]) => {
      queried.push(sql)
      return origQuery(sql, params as unknown[])
    }

    await healUnlockedCardIfNeeded(db, config, 'event-1', 'user-1', 'card-1')

    expect(queried).toHaveLength(1)
  })
})

describe('unlockedPairs（B）', () => {
  it('ペアごとの pair_key と released_positions を返す', async () => {
    const cells = buildAllCenterAchievedCard()
    const { db } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })

    const result = await processCenterAchievement(db, config, 'event-1', 'user-1', 'card-1')

    expect(result.unlockedPairs).toHaveLength(6)
    const byKey = Object.fromEntries(result.unlockedPairs.map((p) => [p.pair_key, p.released_positions]))
    expect(byKey['5-9']).toEqual([1, 13])
    expect(byKey['6-9']).toEqual([3, 12])
    // 平坦な unlockedPositions と内訳の合計が一致する
    expect(result.unlockedPairs.flatMap((p) => p.released_positions).sort((a, b) => a - b)).toEqual(
      [...result.unlockedPositions].sort((a, b) => a - b),
    )
  })

  it('中央3マス目の達成では2ペアぶんの内訳が返る', async () => {
    const cells = buildAllCenterAchievedCard()
    // 中央 10 を未達成に戻す → 成立するのは 5-6 / 5-9 / 6-9 の3ペア
    const c10 = cells.find((x) => x.position === 10)!
    c10.is_achieved = 0
    c10.booth_id = null
    const { db } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })

    const result = await processCenterAchievement(db, config, 'event-1', 'user-1', 'card-1')

    expect(result.unlockedPairs.map((p) => p.pair_key).sort()).toEqual(['5-6', '5-9', '6-9'])
    expect(result.unlockedPositions).toHaveLength(6)
  })
})

// ---------------------------------------------------------------------------
// 自己修復が解放3回ぶんすべてで動く（issue #92 / 00-must-do.md）
//
// is_revealed=0 のマスが残った状態を3パターン（1回目=2マス / 2回目=4マス / 3回目=6マス）
// 作り、healUnlockedCardIfNeeded が全部埋め、strategy='SELF_HEAL' で記録し、
// 二重実行しても recommendation_scores が重複しないことを固定する。
// ---------------------------------------------------------------------------
describe('自己修復が解放3回ぶんすべてで動く（#92）', () => {
  /** pair_key の解放イベントを1行入れ、対応する外周マスを is_revealed=0 に戻す。 */
  async function breakUnlock(db: DbClient, cells: Cell[], id: string, pairKey: string): Promise<number[]> {
    const def = pairDefinitionByKey(pairKey)!
    await db.execute(
      `INSERT INTO card_unlock_events
         (id, card_id, pair_key, line_index, released_positions, phase, strategy, decision_table_size, global_checkin_count)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, 'card-1', pairKey, def.lineIndex, def.releasedPositions.join(','), 'COVERAGE', 'PENDING', null, 10],
    )
    for (const pos of def.releasedPositions) {
      const c = cells.find((x) => x.position === pos)!
      c.is_revealed = 0
      c.booth_id = null
      c.source = null
    }
    return [...def.releasedPositions]
  }

  const rounds: { name: string; pairs: string[]; masu: number }[] = [
    { name: '1回目の解放が落ちた（2マス）', pairs: ['5-6'], masu: 2 },
    { name: '2回目の解放が落ちた（4マス）', pairs: ['5-9', '6-9'], masu: 4 },
    { name: '3回目の解放が落ちた（6マス）', pairs: ['9-10', '6-10', '5-10'], masu: 6 },
  ]

  for (const round of rounds) {
    it(`${round.name}: 自己修復が全マスを埋め SELF_HEAL で記録する`, async () => {
      const cells = buildAllCenterAchievedCard()
      const { db, unlockEvents, scores } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })

      const brokenPositions: number[] = []
      for (const [i, pk] of round.pairs.entries()) {
        brokenPositions.push(...(await breakUnlock(db, cells, `evt-${i}`, pk)))
      }
      expect(brokenPositions).toHaveLength(round.masu)

      await healUnlockedCardIfNeeded(db, config, 'event-1', 'user-1', 'card-1')

      // 壊れていたマスがすべて埋まる
      for (const pos of brokenPositions) {
        const cell = cells.find((c) => c.position === pos)!
        expect(cell.is_revealed).toBe(1)
        expect(cell.booth_id).not.toBeNull()
      }
      // 修復されたペアは strategy='SELF_HEAL'
      const healed = unlockEvents.filter((e) => round.pairs.includes(e.pair_key))
      expect(healed).toHaveLength(round.pairs.length)
      expect(healed.every((e) => e.strategy === 'SELF_HEAL')).toBe(true)
      expect(scores.filter((s) => s.was_assigned === 1)).toHaveLength(round.masu)

      // 二重実行しても recommendation_scores が重複しない
      const before = scores.length
      for (const pos of brokenPositions) {
        const c = cells.find((x) => x.position === pos)!
        c.is_revealed = 0
        c.booth_id = null
      }
      await healUnlockedCardIfNeeded(db, config, 'event-1', 'user-1', 'card-1')
      expect(scores.length).toBe(before)
      const keys = scores.map((s) => `${s.unlock_event_id}:${s.booth_id}`)
      expect(new Set(keys).size).toBe(keys.length)
    })
  }
})

// ---------------------------------------------------------------------------
// 推薦サービス障害時のフォールバック（issue #91 / 00-must-do.md）
//
// 「推薦が落ちる」5つの現実的な障害モードで、解放が必ず成立し
// FALLBACK_COVERAGE で記録され、recommendation_scores に候補全件が残ることを固定する。
// ---------------------------------------------------------------------------
describe('推薦サービス障害時にも解放が成功する（#91）', () => {
  /** fetch を差し替える。挙動は kind で切り替える。 */
  function stubRecommenderFailure(
    kind: 'timeout' | 'http_500' | 'invalid_json' | 'empty_response' | 'unknown_booths',
  ): void {
    vi.stubGlobal('fetch', (async (_url: string, init: { signal?: AbortSignal }) => {
      if (kind === 'timeout') {
        // signal の abort を待って reject する（callRecommender の AbortController 経由）
        return await new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          )
        })
      }
      if (kind === 'http_500') {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
      }
      if (kind === 'invalid_json') {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON')
          },
        } as unknown as Response
      }
      if (kind === 'empty_response') {
        // assigned も scores も無い
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
      }
      // unknown_booths: 存在しない/非活性のブース ID を返す（E10・E11 が効く）
      return {
        ok: true,
        status: 200,
        json: async () => ({
          phase: 'DRSA',
          decision_table_size: 9,
          assigned: [
            { booth_id: 'ghost-1', rank: 1 },
            { booth_id: 'ghost-2', rank: 2 },
          ],
          scores: [
            { booth_id: 'ghost-1', score: 0.9, rank: 1, interest_match: 'MATCH' },
            { booth_id: 'ghost-2', score: 0.8, rank: 2, interest_match: 'PARTIAL' },
          ],
        }),
      } as unknown as Response
    }) as unknown as typeof fetch)
  }

  const cases = ['timeout', 'http_500', 'invalid_json', 'empty_response', 'unknown_booths'] as const

  for (const kind of cases) {
    it(`${kind}: 解放は成立し FALLBACK_COVERAGE で記録される`, async () => {
      stubRecommenderFailure(kind)
      const cells = buildAllCenterAchievedCard()
      const { db, unlockEvents, scores } = makeTestDb({ cardId: 'card-1', cells, boothCount: 40 })
      // タイムアウトを即座に踏むよう短くする
      const cfg: AppConfig = { ...configWithRecommender, recommenderTimeoutMs: 5 }

      const result = await processCenterAchievement(db, cfg, 'event-1', 'user-1', 'card-1')

      // 解放は成立する（外周12マスすべて解放）
      expect(result.unlockedPositions.sort((a, b) => a - b)).toEqual(
        [...OUTER_POSITIONS].sort((a, b) => a - b),
      )
      const outerCells = cells.filter((c) => c.zone === 'OUTER')
      expect(outerCells.every((c) => c.is_revealed === 1)).toBe(true)
      expect(outerCells.every((c) => c.booth_id !== null)).toBe(true)
      // カードに幽霊ブースは載らない（E10・E11）
      expect(outerCells.some((c) => String(c.booth_id).startsWith('ghost-'))).toBe(false)

      // 6ペアすべて FALLBACK_COVERAGE
      expect(unlockEvents).toHaveLength(6)
      expect(unlockEvents.every((e) => e.strategy === 'FALLBACK_COVERAGE')).toBe(true)

      // recommendation_scores に候補全件が記録され、割当は12件
      expect(scores.filter((s) => s.was_assigned === 1)).toHaveLength(12)
      expect(scores.length).toBeGreaterThan(12)
      expect(scores.some((s) => String(s.booth_id).startsWith('ghost-'))).toBe(false)
    })
  }
})
