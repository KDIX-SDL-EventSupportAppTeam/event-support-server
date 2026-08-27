# テスト実行記録 — 2026-08-28（マイグレーション09の追従漏れ修正）

## 何を

### 対象（src）

- `src/routes/v1/admin/analytics.ts`（推薦集計を `recommendation_scores` へ移行）
- `src/lib/event-data/clear-all.ts`（`DELETE FROM recommendations` を廃止）
- `src/lib/sample-data/clear.ts` / `src/lib/sample-data/generate.ts`（推薦テーブル参照を廃止）
- `src/scripts/seed-sample.ts`

### テストコード（tests）

- `tests/unit/organizer-event-data.test.ts`（戻り値から `recommendations` が消えることに追従）

## なぜ

マイグレーション `09_bingo_staged_unlock.sql` で `recommendations` テーブルが削除され
`recommendation_scores` へ置き換わったが、コードが追従できておらず
`/bingo/card`・運営分析（booths / recommendations）・`db:clear:event` が 500 / 失敗していた。
仕様書 `docs/specs/migration-09-followup/README.md`（状態: 確定）に従う。

## 実行コマンド

```bash
npm test
npm run build
```

## 環境

- ブランチ: `integration/2026-08-migration-09-followup`（作業: `fix/event-data-clear-recommendations` → `fix/analytics-recommendation-scores`）
- MySQL: 起動済み（`docker compose up -d mysql`、`db:seed` + `db:seed:sample` 済み）
- 関連 PR / Issue: PR #82（仕様書。マージ済み）

## 結果

- `npm test`: 24 ファイル / 287 件すべて成功
- `npm run build`: 成功（tsc エラーなし）
- 実機確認（イベント `20000000-0000-4000-8000-000000000001`）:
  - `GET /events/:id/bingo/card` → 200（マイグレーション側は `origin/feat/bingo-unlock-1-schema` が既に develop に取り込まれており復旧済み）
  - `GET /admin/events/:id/analytics/{booths,recommendations,participants,checkins}` → いずれも 200
  - `card_unlock_events` + `recommendation_scores` を手動投入して集計を確認:
    - `summary`: total 2 / selected 1 / acceptance_rate 50 / open 1 / algorithm "mab"
    - `by_booth`・`recommendation_*` フィールドが期待通り（型・null 許容も維持）
  - `db:seed:sample` → `db:clear:event` 後、`check_ins` が 214 → 0 件
  - `db:seed:sample` → `db:clear:sample` 成功

## メモ

- `selected` の意味が「利用者が選んだ」→「システムが割り当てた（`was_assigned`）」に変わった。
  `analytics.ts` にコメント、`docs/reference/api-endpoints.md` に記録済み。
- サンプル生成は `recommendation_scores` を作らないため、サンプル投入時の推薦分析は 0 件表示（エラーではない）。
- 研究用の新指標（フェーズ別・`interest_match` 別）は未着手（定義未確定・別 PR）。
