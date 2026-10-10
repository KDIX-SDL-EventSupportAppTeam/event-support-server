/**
 * #176 検証用ハーネス。ローカル MySQL ＋ sakura-proxy-mock（子プロセス）経由で、
 * 本番と同じ「1リクエスト=1SQL・エラーは 500 に潰れる・数値は文字列で届く」条件を再現する。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Server } from 'socket.io'
import type { AppConfig } from '../../../src/config.js'
import type { DbClient } from '../../../src/db/client.js'
import { createHttpProxy } from '../../../src/db/http-proxy.js'
import { withTypeCoercion } from '../../../src/db/type-coerce.js'
import { bingoRoutes } from '../../../src/routes/v1/bingo.js'
import { checkinRoutes } from '../../../src/routes/v1/checkins.js'
import { sendFail } from '../../../src/lib/response.js'
import { config as baseConfig, makePool, participantToken } from '../gacha/helpers.js'

const PROXY_KEY = 'harness-key'

export interface Harness {
  raw: DbClient
  proxied: DbClient
  stop: () => Promise<void>
}

/** mock プロキシを子プロセスで起動する。 */
async function freePort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as AddressInfo).port
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

export async function startHarness(): Promise<Harness> {
  const raw = makePool()
  const PROXY_PORT = await freePort()
  const child: ChildProcess = spawn('npx', ['tsx', 'src/scripts/sakura-proxy-mock.ts'], {
    env: {
      ...process.env,
      SAKURA_PROXY_KEY: PROXY_KEY,
      PROXY_PORT: String(PROXY_PORT),
      DATABASE_URL: process.env.DATABASE_URL ?? 'mysql://app:appsecret@127.0.0.1:3306/event_support',
    },
    stdio: process.env.MOCK_LOG ? 'inherit' : 'ignore',
  })
  const proxied = withTypeCoercion(createHttpProxy(`http://127.0.0.1:${PROXY_PORT}/query`, PROXY_KEY))
  for (let i = 0; i < 60; i++) {
    try {
      await proxied.query('SELECT 1')
      break
    } catch {
      await new Promise((r) => setTimeout(r, 250))
      if (i === 59) throw new Error('proxy mock が起動しませんでした')
    }
  }
  return {
    raw,
    proxied,
    stop: async () => {
      child.kill('SIGTERM')
      await raw.end()
    },
  }
}

export type RecommenderMode = 'none' | 'unique' | 'duplicate-scores'

/** 推薦エンジンの代役。delayMs でチェックイン中の「解放の途中」の時間を伸ばす。 */
export async function startFakeRecommender(
  mode: Exclude<RecommenderMode, 'none'>,
  delayMs: number,
  avoid: readonly string[] = [],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: HttpServer = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      await new Promise((r) => setTimeout(r, delayMs))
      const r = JSON.parse(body) as {
        cell_count: number
        candidate_booths: { booth_id: string }[]
      }
      // これからチェックインするブースを推薦で先取りしない（検証の目的外の分岐に入らないため）
      const ids = r.candidate_booths.map((c) => c.booth_id).sort()
      const pick = ids.filter((id) => !avoid.includes(id))
      const assigned = pick.slice(0, r.cell_count).map((id, i) => ({ booth_id: id, score: 1 - i * 0.01, rank_in_event: i + 1 }))
      const scores = ids.map((id, i) => ({ booth_id: id, score: 1 - i * 0.01, rank_in_event: i + 1, interest_match: 'UNKNOWN' }))
      if (mode === 'duplicate-scores') scores.push(scores[0], scores[1])
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ phase: 'DRSA', decision_table_size: 10, assigned, scores }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) }
}

export async function buildBingoApp(db: DbClient, recommenderUrl: string): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', { ...baseConfig, recommenderUrl, recommenderTimeoutMs: 3000 } as AppConfig)
  app.decorate('db', db)
  app.decorate('io', { to: () => ({ emit: () => {} }) } as unknown as Server)
  await app.register(
    async (v1) => {
      await v1.register(bingoRoutes)
      await v1.register(checkinRoutes)
    },
    { prefix: '/api/v1' },
  )
  app.setErrorHandler((err, _req, reply) => {
    if (reply.sent) return
    sendFail(reply, 500, 'INTERNAL_ERROR', String(err))
  })
  await app.ready()
  return app
}

export interface World {
  eventId: string
  organizerId: string
  boothIds: string[]
}

export async function seedWorld(raw: DbClient, boothCount = 40): Promise<World> {
  const eventId = randomUUID()
  const organizerId = randomUUID()
  await raw.execute(`INSERT INTO organizers (id, email, password_hash, display_name) VALUES (?,?,?,?)`, [
    organizerId, `org-${organizerId}@example.com`, 'x', '運営',
  ])
  await raw.execute(
    `INSERT INTO events (id, organizer_id, name, date_start, date_end)
     VALUES (?,?,?, '2026-10-16 00:00:00', '2026-10-16 23:59:59')`,
    [eventId, organizerId, '並行処理検証'],
  )
  const boothIds: string[] = []
  for (let i = 0; i < boothCount; i++) {
    const id = randomUUID()
    boothIds.push(id)
    await raw.execute(
      `INSERT INTO booths (id, event_id, name, manual_code, qr_token) VALUES (?,?,?,?,?)`,
      [id, eventId, `ブース${i}`, String(100000 + i), randomUUID().replace(/-/g, '').slice(0, 10)],
    )
  }
  return { eventId, organizerId, boothIds }
}

export async function cleanupWorld(raw: DbClient, w: World): Promise<void> {
  await raw.execute(`DELETE FROM events WHERE id = ?`, [w.eventId])
  await raw.execute(`DELETE FROM organizers WHERE id = ?`, [w.organizerId])
}

export async function newUser(raw: DbClient, w: World): Promise<{ userId: string; token: string }> {
  const userId = randomUUID()
  await raw.execute(
    `INSERT INTO users (id, event_id, email, display_name, role, email_verified_at)
     VALUES (?,?,?,?, 'participant', '2026-10-01 00:00:00')`,
    [userId, w.eventId, `u-${userId}@example.com`, '参加者'],
  )
  return { userId, token: participantToken(userId, w.eventId) }
}

export interface Res {
  status: number
  body: any
}

export async function checkin(app: FastifyInstance, w: World, token: string, boothId: string): Promise<Res> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/v1/events/${w.eventId}/checkins`,
    headers: { authorization: `Bearer ${token}` },
    payload: { method: 'qr', booth_id: boothId, checked_in_at: new Date().toISOString() },
  })
  return { status: r.statusCode, body: r.json() }
}

export async function getCard(app: FastifyInstance, w: World, token: string): Promise<Res> {
  const r = await app.inject({
    method: 'GET',
    url: `/api/v1/events/${w.eventId}/bingo/card`,
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: r.statusCode, body: r.json() }
}

export interface Findings {
  /** 同じ booth_id が複数マスに載っている（uq_cell_card_booth があるので通常 0） */
  duplicateBooths: number
  /** 解放済みなのに is_revealed=0 のまま残っている外周マス（終端状態を除く） */
  unrevealedReleased: number
  /** is_revealed=1 なのに booth_id が空で、NO_CANDIDATE でもないマス */
  revealedWithoutBooth: number
  /** 解放が最後まで確定していない（strategy が PENDING のまま） */
  pendingUnlockEvents: number
  /** recommendation_scores の was_assigned=1 のブースが、カードの該当マスのブースと一致しない解放イベント */
  scoreMismatchEvents: number
  /** 中央マスのうち booth_id が空のもの / チェックイン済みなのに cell_id が空のもの（カード外訪問を除く目安） */
  emptyCenterCells: number
  checkinsWithoutCell: number
}

export async function inspectCard(raw: DbClient, userId: string): Promise<Findings> {
  const q = async (sql: string, p: unknown[]) => (await raw.query(sql, p))[0] as Record<string, any>[]
  const [card] = await q(`SELECT id FROM bingo_cards WHERE user_id = ? LIMIT 1`, [userId])
  const cardId = card.id as string

  const dup = await q(
    `SELECT booth_id FROM bingo_cells WHERE card_id = ? AND booth_id IS NOT NULL GROUP BY booth_id HAVING COUNT(*) > 1`,
    [cardId],
  )
  const events = await q(
    `SELECT id, pair_key, released_positions, strategy FROM card_unlock_events WHERE card_id = ? AND pair_key <> 'PRESURVEY'`,
    [cardId],
  )
  const cells = await q(`SELECT position, zone, booth_id, is_revealed, is_achieved, source FROM bingo_cells WHERE card_id = ?`, [cardId])
  const byPos = new Map(cells.map((c) => [Number(c.position), c]))

  let unrevealedReleased = 0
  let scoreMismatchEvents = 0
  for (const ev of events) {
    const positions = String(ev.released_positions).split(',').map(Number)
    for (const pos of positions) {
      const c = byPos.get(pos)
      if (c && Number(c.is_revealed) === 0) unrevealedReleased++
    }
    const onCard = new Set(positions.map((p) => byPos.get(p)?.booth_id).filter(Boolean) as string[])
    const scored = await q(`SELECT booth_id FROM recommendation_scores WHERE unlock_event_id = ? AND was_assigned = 1`, [ev.id])
    const scoredSet = new Set(scored.map((s) => s.booth_id as string))
    const same = onCard.size === scoredSet.size && [...onCard].every((b) => scoredSet.has(b))
    if (!same) scoreMismatchEvents++
  }
  const [cnt] = await q(`SELECT COUNT(*) AS c FROM check_ins WHERE user_id = ? AND cell_id IS NULL`, [userId])
  return {
    duplicateBooths: dup.length,
    unrevealedReleased,
    revealedWithoutBooth: cells.filter((c) => Number(c.is_revealed) === 1 && !c.booth_id && c.source !== 'NO_CANDIDATE').length,
    pendingUnlockEvents: events.filter((e) => e.strategy === 'PENDING').length,
    scoreMismatchEvents,
    emptyCenterCells: cells.filter((c) => c.zone === 'CENTER' && !c.booth_id).length,
    checkinsWithoutCell: Number(cnt.c),
  }
}

/**
 * このユーザーのカードにまだ載っておらず、訪問もしていないブースを n 件返す。
 * 解放で外周マスに載ったブースをこの後チェックインすると中央マスが埋まらず、
 * 検証したいこと（中央マスの競合）と別の分岐に入ってしまうため、チェックイン先は毎回これで選ぶ。
 */
export async function unseenBooths(raw: DbClient, w: World, userId: string, n: number): Promise<string[]> {
  const [rows] = await raw.query(
    `SELECT booth_id FROM bingo_cells WHERE card_id IN (SELECT id FROM bingo_cards WHERE user_id = ?) AND booth_id IS NOT NULL
     UNION SELECT booth_id FROM check_ins WHERE user_id = ?`,
    [userId, userId],
  )
  const used = new Set((rows as { booth_id: string }[]).map((r) => r.booth_id))
  return w.boothIds.filter((b) => !used.has(b)).slice(0, n)
}
