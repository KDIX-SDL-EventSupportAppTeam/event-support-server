/**
 * アワード結果の順位付け（運営向け結果画面。docs/specs/gacha-and-award/06-api/award-api.md「結果」）。
 *
 * **同数は同順位**（標準競技順位: 23, 23, 20 → 1位, 1位, 3位）。
 * `limit` 位以内の行はすべて返すので、同率で `limit` 件を超えることがある（同率を切り捨てない）。
 * 入力は票数の降順に並んでいること（SQL の ORDER BY votes DESC）。
 */
export type RankedBooth = { rank: number; booth_id: string; booth_name: string; votes: number }

export function rankTopBooths(
  rows: { booth_id: string; booth_name: string; votes: number }[],
  limit = 3,
): RankedBooth[] {
  const out: RankedBooth[] = []
  let rank = 0
  let prevVotes: number | null = null
  rows.forEach((r, i) => {
    if (r.votes !== prevVotes) rank = i + 1
    prevVotes = r.votes
    if (rank <= limit && r.votes > 0) out.push({ rank, ...r })
  })
  return out
}
