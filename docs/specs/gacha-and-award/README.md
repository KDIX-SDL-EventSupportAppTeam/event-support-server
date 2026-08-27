---
状態: 確定
最終更新: 2026-08-27
---

# ガチャコイン

ビンゴの成立ライン数を原資に、参加者が実物のガチャポン筐体を回す権利（コイン）を
発行・消費する機能。**アワード投票は本仕様に含まない**（コインと独立に後から追加する）。

## 目次

| ディレクトリ | 内容 |
|---|---|
| [00-must-do.md](00-must-do.md) | 本番までに絶対にやること |
| [01-concept/](01-concept/decisions.md) | 決定事項と用語 |
| [02-data-model/](02-data-model/schema.md) | テーブル定義とマイグレーション |
| [03-coin-lifecycle/](03-coin-lifecycle/earning.md) | 獲得・消費・排他制御 |
| [04-api/](04-api/participant-api.md) | API 契約 |
| [05-frontend/](05-frontend/screens.md) | 画面（正本は frontend リポジトリ） |
| [09-open-questions/](09-open-questions/open-questions.md) | 未決定 |
| [10-testing/](10-testing/README.md) | テスト仕様 |

## 現状（2026-08-27 時点の実装）

| 対象 | 状態 |
|---|---|
| `gacha_coin_uses` | migration 09 で作成済み。`id / event_id / user_id / used_at` のみ、**ユニーク制約なし** |
| `src/routes/v1/gacha.ts` | 器として存在。`MAX_COINS = 10` がハードコード、`min(lines, 10)` 換算 |
| `POST /gacha/coins/use` | 素の INSERT。**二重タップ・再送で多重消費する**（未修正） |
| frontend `/gachapon` 系3画面 | `LegacyPlaceholderPage`。旧 Flask 呼び出しは削除済み |
| 旧 Flask 版（参考） | `max_coins = 4`、`min(bingo, 4) - spent` |

## 確定した仕様の骨子（2026-08-27）

- **1ライン = 1枚、上限 4枚**（G-11）
- **スタッフの立会いは無く、操作はアプリ内で完結する**（G-10）

## 絶対に守る依存の向き

```
ガチャ  ──参照──▶  ビンゴ（成立ライン数）
ビンゴ  ──✕──▶  ガチャ
```

ビンゴが計算するのは成立ライン数まで。ライン数からコイン枚数への換算は**ガチャ側の責務**。
`calcCoinsEarned()` を `src/lib/bingo/` に置いてはならない（bingo D-5）。

## 中途半端に残さない

旧 Flask を呼ぶコードは削除済み。復活させない。
`ApiParticipantClient` に残っているガチャのスタブ（`getAvailableGachaponCoins` /
`postUseGachaponCoin`）は、実装時に削除して `features/gachapon/api/` へ移す。
