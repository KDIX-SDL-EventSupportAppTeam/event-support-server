/**
 * 対象: src/routes/v1/checkins.ts（中央マスの後出し割当）, src/lib/bingo/assignOuterCells.ts（推薦応答の重複）
 * 仕様: issue #176
 *
 * ローカル MySQL ＋ sakura-proxy-mock（子プロセス）経由。DB は db/migrations/ を最新まで適用済みであること。
 * 再現確認の全体は repro.test.ts（通常は実行しない）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildBingoApp, checkin, cleanupWorld, getCard, inspectCard, newUser, seedWorld, startFakeRecommender, startHarness, unseenBooths,
  type Harness, type World,
} from './harness.js'

let h: Harness
let w: World

beforeAll(async () => {
  h = await startHarness()
  w = await seedWorld(h.raw, 30)
}, 60000)
afterAll(async () => {
  await cleanupWorld(h.raw, w)
  await h.stop()
})

describe('#176 中央マスの競合に負けても再試行する', () => {
  it('同じユーザーの 2 件のチェックインが同時に来ても、両方が中央マスに入る（チェックインだけ記録されて取りこぼされない）', async () => {
    const app = await buildBingoApp(h.proxied, '')
    for (let round = 0; round < 8; round++) {
      const u = await newUser(h.raw, w)
      for (const b of w.boothIds.slice(0, 2)) await checkin(app, w, u.token, b)
      // 空きの中央マスは 2 つ。同時に来た 2 件が同じマスを取り合う（解放で外周に載ったブースは避ける）
      const [b3, b4] = await unseenBooths(h.raw, w, u.userId, 2)
      const rs = await Promise.all([checkin(app, w, u.token, b3), checkin(app, w, u.token, b4)])

      const f = await inspectCard(h.raw, u.userId)
      expect(rs.map((r) => r.status)).not.toContain(404)
      expect(f.emptyCenterCells).toBe(0) // 起きてはいけない: 中央マスが空のまま
      expect(f.checkinsWithoutCell).toBe(0) // 起きてはいけない: 記録だけあって cell_id が無いチェックイン
      expect(f.duplicateBooths).toBe(0)
    }
    await app.close()
  }, 120000)
})

describe('#176 推薦の応答に同じブースが重複していても 500 にならない', () => {
  it('scores の重複は 1 件に畳まれ、全チェックインが 200。解放は最後まで確定する', async () => {
    const rec = await startFakeRecommender('duplicate-scores', 0, w.boothIds.slice(0, 4))
    const app = await buildBingoApp(h.proxied, rec.url)
    const u = await newUser(h.raw, w)
    const statuses: number[] = []
    for (const b of w.boothIds.slice(0, 4)) statuses.push((await checkin(app, w, u.token, b)).status)
    const card = await getCard(app, w, u.token)
    await app.close()
    await rec.close()

    expect(statuses).toEqual([200, 200, 200, 200]) // 起きてはいけない: 500
    expect(card.status).toBe(200)
    const f = await inspectCard(h.raw, u.userId)
    expect(f.pendingUnlockEvents).toBe(0) // 起きてはいけない: 解放が PENDING のまま
    expect(f.unrevealedReleased).toBe(0)
    expect(f.scoreMismatchEvents).toBe(0)
  }, 120000)
})
