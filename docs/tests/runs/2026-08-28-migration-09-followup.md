# テスト実行記録 — 2026-08-28（マイグレーション09の追従漏れ修正）

## 何を

### 対象（src）

- `src/lib/analytics/recommendationScores.ts`（**新規**。推薦集計の純関数と SQL を切り出し）
- `src/routes/v1/admin/analytics.ts`（推薦集計を `recommendation_scores` へ移行）
- `src/lib/event-data/clear-all.ts`（`DELETE FROM recommendations` を廃止し CASCADE に委ねる）
- `src/lib/sample-data/clear.ts`（推薦テーブル参照を廃止／ブース削除前にマス割り当てを解除）
- `src/lib/sample-data/generate.ts`（推薦データ生成を廃止）
- `src/routes/v1/admin/sample-data.ts` / `src/scripts/seed-sample.ts` / `src/scripts/clear-sample.ts`

### テストコード（tests）

- `tests/unit/analytics-recommendation-scores.test.ts`（**新規**。集計の純関数・SQL の JOIN 経路）
- `tests/unit/admin-analytics-recommendations.test.ts`（**新規**。応答フィールドの形の契約）
- `tests/unit/sample-data-clear.test.ts`（**新規**。削除順序とマス割り当て解除）
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

- ブランチ: `integration/2026-08-migration-09-followup`
- MySQL: 起動済み（`docker compose up -d mysql`、`db:seed` + `db:seed:sample` 済み）
- 関連 PR / Issue: PR #82（仕様書。マージ済み）、PR #80（取り残しを本ブランチで回収）

## 結果

- `npm test`: **27 ファイル / 316 件すべて成功**（着手前は 24 ファイル / 287 件）
- `npm run build`: 成功（tsc エラーなし）

### 実機確認（イベント `20000000-0000-4000-8000-000000000001`）

| 対象 | 修正前 | 修正後 |
|---|---|---|
| `GET /events/:id/bingo/card` | 200 | 200 |
| `GET /admin/…/analytics/booths` | 500 `ER_NO_SUCH_TABLE` | 200 |
| `GET /admin/…/analytics/recommendations` | 500 `ER_NO_SUCH_TABLE` | 200 |
| `GET /admin/…/analytics/participants` | 200 | 200 |
| `GET /admin/…/analytics/checkins` | 200 | 200 |

- `card_unlock_events` 3件（`random`×1・`mab`×2）と `recommendation_scores` 5行（割当3）を投入して集計確認:
  - `summary` = `{total_recommendations:5, selected_count:3, acceptance_rate:60, open_count:2, algorithm:"mab"}`
  - `algorithm` は候補行数（`random` 3行）ではなく**解放イベント数**（`mab` 2件）で決まることを実機で確認
  - `recommendation_acceptance_rate` は候補ありで `number`、候補なしのブースで `null` を維持
- `DELETE FROM bingo_cards` で `card_unlock_events` / `recommendation_scores` が
  CASCADE で消えることを実データ（1件ずつ投入）で確認
- `db:seed:sample` → `db:clear:event` 後、`check_ins` が 214 → 0 件
- `db:clear:sample`: 実参加者のカードに**達成済み**でサンプルブースが載った状態で実行し、
  修正前の `ER_ROW_IS_REFERENCED` が解消。カード・マスは保持され `booth_id` のみ NULL 化
  （`割り当てを外したマス: 1`）

### 変異テスト（テストが退行を検出できることの確認）

意図的に実装を壊し、テストが落ちることを確認した（通るだけのテストになっていないか）。

| 壊し方 | 結果 |
|---|---|
| SQL を旧 `FROM recommendations` に戻す | 12 件が失敗 |
| `strategy` 最頻値を候補行単位で数える | 1 件が失敗 |
| マス割り当て解除を `DELETE FROM booths` の後ろへ移す | 1 件が失敗 |

いずれも復元後に全件成功することを確認済み。

## メモ

- `selected` の意味が「利用者が選んだ」→「システムが割り当てた（`was_assigned`）」に変わった。
  `recommendationScores.ts` の冒頭と `docs/reference/api-endpoints.md` に記録済み。
- サンプル生成は `recommendation_scores` を作らないため、サンプル投入時の推薦分析は 0 件表示（エラーではない）。
- 研究用の新指標（フェーズ別・`interest_match` 別）は未着手（定義未確定・別 PR）。
- PR #80（`feat/bingo-unlock-2-api-tests`）のドキュメント5コミットが develop へ取り残されていたため、
  本ブランチで回収した。経緯と再発防止は
  [ADR 0005](../../decisions/adrs/0005-stacked-pr-merge-order.md)。
- 回収した `docs/reference/api-endpoints.md` は `analytics/recommendations` を一覧から削除していたが、
  **これは PR #80 内の記載ミス**である。同じ PR の
  `docs/specs/bingo-dynamic-unlock/06-api/admin-api.md` は同エンドポイントについて
  「`recommendation_scores` を読むように変更する（改修）」と書いており、存続が前提になっている。
  同時に削除された参加者向け `/recommendations` 2本はコードに実在しないため削除が正しく、
  実在する運営の1本だけを巻き込んだものと判断して復活させた。
