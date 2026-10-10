/**
 * #176 の再現確認。結果は表示するだけで、合否は判定しない（再現の有無を数えるためのもの）。
 *
 *   RUN_BINGO_CONCURRENCY_REPRO=1 ROUNDS=40 DATABASE_URL=mysql://… npx vitest run tests/integration/bingo-concurrency/repro.test.ts
 *
 * 数分かかるため、通常の `npm test` では実行しない。
 * 前提: ローカル MySQL に db/migrations/ を最新まで適用済みであること。
 */
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  buildBingoApp, checkin, cleanupWorld, getCard, inspectCard, newUser, seedWorld, startFakeRecommender, startHarness, unseenBooths,
  type Findings, type Harness, type Res, type World,
} from './harness.js'

const ROUNDS = Number(process.env.ROUNDS ?? 20)
let h: Harness
let w: World

beforeAll(async () => {
  if (!process.env.RUN_BINGO_CONCURRENCY_REPRO) return
  h = await startHarness()
  w = await seedWorld(h.raw, 40)
}, 60000)
afterAll(async () => {
  if (!process.env.RUN_BINGO_CONCURRENCY_REPRO) return
  await cleanupWorld(h.raw, w)
  await h.stop()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function tally(name: string, rs: Res[], findings: Findings[], extra: Record<string, unknown> = {}) {
  const sum = (k: keyof Findings) => findings.filter((f) => f[k] > 0).length
  const firstError = rs.find((r) => r.status >= 500)
  console.log(
    `RESULT ${name} ` +
      JSON.stringify({
        rounds: findings.length,
        status: rs.reduce<Record<string, number>>((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {}),
        roundsWith: {
          duplicateBooths: sum('duplicateBooths'),
          unrevealedReleased: sum('unrevealedReleased'),
          revealedWithoutBooth: sum('revealedWithoutBooth'),
          pendingUnlockEvents: sum('pendingUnlockEvents'),
          scoreMismatchEvents: sum('scoreMismatchEvents'),
          emptyCenterCells: sum('emptyCenterCells'),
          checkinsWithoutCell: sum('checkinsWithoutCell'),
        },
        ...extra,
        firstError: firstError ? JSON.stringify(firstError.body).slice(0, 200) : null,
      }),
  )
}

// 推薦の遅延（0 = 推薦サービスなし＝フォールバックのみ）
for (const delay of [0, 150]) {
  describe.skipIf(!process.env.RUN_BINGO_CONCURRENCY_REPRO)(`推薦 ${delay === 0 ? 'なし' : `遅延${delay}ms`}`, () => {
    const setup = async () => {
      const reserved: string[] = []
      const rec = delay === 0 ? null : await startFakeRecommender('unique', delay, reserved)
      const app = await buildBingoApp(h.proxied, rec?.url ?? '')
      return { rec, app }
    }

    // S1: 解放を起こすチェックインの最中に、カード GET（自己修復）を 15ms おきに撃ち続ける
    it(`S1 チェックイン POST × カード GET 連打 (${delay}ms)`, async () => {
      const { rec, app } = await setup()
      const rs: Res[] = []
      const findings: Findings[] = []
      for (let i = 0; i < ROUNDS; i++) {
        const u = await newUser(h.raw, w)
        for (const b of w.boothIds.slice(0, 3)) await checkin(app, w, u.token, b)
        let done = false
        const [b4] = await unseenBooths(h.raw, w, u.userId, 1)
        const post = checkin(app, w, u.token, b4).then((r) => ((done = true), r))
        const gets: Promise<Res>[] = []
        while (!done) {
          gets.push(getCard(app, w, u.token))
          await sleep(15)
        }
        rs.push(await post, ...(await Promise.all(gets)))
        findings.push(await inspectCard(h.raw, u.userId))
      }
      tally(`S1/${delay}`, rs, findings)
      await app.close()
      await rec?.close()
    }, 600000)

    // S2: 同じユーザーが別ブースへほぼ同時にチェックイン（オフライン同期の並列送信）。2本目を d ms 遅らせる
    for (const d of [0, 10, 40]) {
      it(`S2 チェックイン POST × 2（2本目を${d}ms遅らせる）(${delay}ms)`, async () => {
        const { rec, app } = await setup()
        const rs: Res[] = []
        const findings: Findings[] = []
        let nullFilled = 0
        const afterHeal: Findings[] = []
        for (let i = 0; i < ROUNDS; i++) {
          const u = await newUser(h.raw, w)
          for (const b of w.boothIds.slice(0, 2)) await checkin(app, w, u.token, b)
          const [b3, b4] = await unseenBooths(h.raw, w, u.userId, 2)
          const second = sleep(d).then(() => checkin(app, w, u.token, b4))
          const first = checkin(app, w, u.token, b3)
          const both = await Promise.all([first, second])
          rs.push(...both)
          nullFilled += both.filter((r) => r.status === 200 && r.body.data.filled_cell === null).length
          findings.push(await inspectCard(h.raw, u.userId)) // GET で回収する前の状態
          await getCard(app, w, u.token)
          afterHeal.push(await inspectCard(h.raw, u.userId)) // 自己修復（GET）後の状態
        }
        tally(`S2/${delay}/d${d}`, rs, findings, {
          filledCellNullResponses: nullFilled,
          afterHeal: {
            unrevealedReleased: afterHeal.filter((f) => f.unrevealedReleased > 0).length,
            pendingUnlockEvents: afterHeal.filter((f) => f.pendingUnlockEvents > 0).length,
            scoreMismatchEvents: afterHeal.filter((f) => f.scoreMismatchEvents > 0).length,
          },
        })
        await app.close()
        await rec?.close()
      }, 600000)
    }
  })
}

describe.skipIf(!process.env.RUN_BINGO_CONCURRENCY_REPRO)('推薦の応答に重複', () => {
  it('S4 scores に同じブースが重複', async () => {
    const rec = await startFakeRecommender('duplicate-scores', 0, w.boothIds.slice(0, 4))
    const app = await buildBingoApp(h.proxied, rec.url)
    const rs: Res[] = []
    const findings: Findings[] = []
    for (let i = 0; i < 5; i++) {
      const u = await newUser(h.raw, w)
      for (const b of w.boothIds.slice(0, 4)) rs.push(await checkin(app, w, u.token, b))
      await getCard(app, w, u.token)
      findings.push(await inspectCard(h.raw, u.userId))
    }
    tally('S4', rs, findings)
    await app.close()
    await rec.close()
  }, 120000)
})
