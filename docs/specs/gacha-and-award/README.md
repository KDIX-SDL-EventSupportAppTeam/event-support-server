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

## 現状（2026-08-28 時点の実装 — feat/gacha-coins）

| 対象 | 状態 |
|---|---|
| `gacha_coin_uses` | migration 10 で作り直し。`coin_index` / `idempotency_key` と `uk_gacha_coin` / `uk_gacha_idem` の2本 |
| `gacha_settings` | migration 10 で新規（`is_enabled / coins_per_line / max_coins / bonus_coins`、既定 `0/1/4/0`） |
| `src/lib/gacha/coins.ts` | `calcCoinsEarned(lines, settings)`（純関数。bingo に非依存） |
| `src/lib/gacha/settings.ts` | `fetchGachaSettings`（行なし・列 NULL でも既定値で埋める） |
| `src/lib/gacha/useCoin.ts` | HAVING 付き単一 INSERT ... SELECT。例外時は冪等キーで SELECT、衝突は収束まで再試行 |
| `src/routes/v1/gacha.ts` | `MAX_COINS` 撤去。GET/POST を participant-api.md の契約に一致 |
| `src/routes/v1/organizer/gacha-settings.ts` | GET/PUT（organizer・所有チェック・範囲バリデーション・audit_logs） |
| `src/routes/v1/admin/gacha.ts` | `GET /admin/events/:id/gacha/stats`（当日モニタ） |
| frontend `/gachapon` 系3画面 | 実装（`features/gachapon/`。`LegacyPlaceholderPage` を撤去） |
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
