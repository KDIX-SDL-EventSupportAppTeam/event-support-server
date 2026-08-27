---
状態: 確定
最終更新: 2026-08-27
---

# 獲得（earned の算出）

```
lines   = countCompletedLines(achieved)          … ビンゴ側の純関数（src/lib/bingo/lines.ts）
earned  = min(lines * coins_per_line, max_coins) + bonus_coins
```

`src/lib/gacha/coins.ts`:

```ts
export interface GachaSettings {
  isEnabled: boolean
  coinsPerLine: number
  maxCoins: number
  bonusCoins: number
}

/** ライン数からコイン獲得枚数へ換算する（DB を触らない純関数）。 */
export function calcCoinsEarned(lines: number, s: GachaSettings): number {
  const fromLines = Math.min(lines * s.coinsPerLine, s.maxCoins)
  return Math.max(0, fromLines + s.bonusCoins)
}
```

## 性質

- **単調非減少**: `lines` は減らないため `earned` も減らない。よって「消費の直前に読んだ `earned`」を
  判断材料にしてよい。古い値は必ず現在値以下であり、**過剰消費の方向には振れない**
- `bonus_coins` は上限の外側に足す。「上限4枚だが全員に1枚配る」を表現できるようにするため
- 負の値を返さない（`bonus_coins` に負値が入っても 0 で止める）

## 上限に達した後

`lines` がさらに増えても `earned` は増えない。UI にはライン数と枚数を両方出し、
「これ以上ラインを増やしてもコインは増えない」ことが分かるようにする（frontend 側の責務）。

## 確定した換算（G-11）

`coins_per_line = 1`, `max_coins = 4`, `bonus_coins = 0`。

| 成立ライン数 | 0 | 1 | 2 | 3 | 4 | 5..10 |
|---|---|---|---|---|---|---|
| 獲得枚数 | 0 | 1 | 2 | 3 | 4 | 4 |

**4ライン目で頭打ち。** ビンゴは中央2マス＋同一ラインの外周2マスの計4訪問で1ライン成立するため、
上限4枚には最短でも相応の周遊が要る。
