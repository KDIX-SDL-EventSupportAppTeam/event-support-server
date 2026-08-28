---
状態: 確定
最終更新: 2026-08-27
---

# 純関数で網羅する組み合わせ

対象: `calcCoinsEarned(lines, settings)`（`src/lib/gacha/coins.ts`）。

## ライン数 × 設定の総当たり

`lines` は 0..10（4x4 の全ライン数は10本）。設定は以下を掛け合わせる。

| 軸 | 値 |
|---|---|
| `coins_per_line` | 0, 1, 2 |
| `max_coins` | 0, 1, 4, 50 |
| `bonus_coins` | 0, 1 |

**11 × 3 × 4 × 2 = 264 通りを総当たり**し、各ケースで次を検証する。

- 返り値が `min(lines * coins_per_line, max_coins) + bonus_coins` と一致する
- 返り値が **0 未満にならない**
- `lines` を1増やしたときの返り値が**減らない**（単調非減少。G-2 の前提そのもの）

## 確定値の固定ケース（G-11）

`{coinsPerLine: 1, maxCoins: 4, bonusCoins: 0}` について、表を丸ごと固定する。
**設定を変えたつもりが無いのに換算が変わったら落ちる**ようにするため。

| lines | 0 | 1 | 2 | 3 | 4 | 5 | 10 |
|---|---|---|---|---|---|---|---|
| earned | 0 | 1 | 2 | 3 | 4 | 4 | 4 |

## 境界

| ケース | 期待 |
|---|---|
| `lines = 0` | `bonus_coins` のみ |
| `lines = 上限に達する直前` | 上限未満 |
| `lines = 上限に達する点` | ちょうど `max_coins + bonus_coins` |
| `lines = 10`（全ライン） | `max_coins + bonus_coins` を超えない |
| `coins_per_line = 0` | ライン数に関わらず `bonus_coins` |
| `max_coins = 0`, `bonus_coins = 0` | 常に 0 |
| `bonus_coins` が負（不正データ） | 0 で止まる。例外を投げない |

## 「起きてはいけないこと」

**人間は「起きるべきこと」しかテストしない。以下を明示的に書く。**

- `earned` が `max_coins + bonus_coins` を**超えない**
- ライン数が増えて `earned` が**減らない**
- 設定オブジェクトが**書き換えられない**（純関数であること）
- `NaN` / `Infinity` を返さない（`lines` に負値や小数を与えても）
- **`src/lib/bingo/` から `calcCoinsEarned` を import している箇所が無い**
  （依存の向きを静的に検査する。`grep -r "gacha" src/lib/bingo/` が空であること）

## 設定フォールバック

`src/lib/gacha/settings.ts` の単体テスト。

- 行が無いとき既定値 `{ isEnabled: false, coinsPerLine: 1, maxCoins: 4, bonusCoins: 0 }` を返す
- 一部の列が NULL のとき、その列だけ既定値で埋める
- **行が無いことが例外にならない**
