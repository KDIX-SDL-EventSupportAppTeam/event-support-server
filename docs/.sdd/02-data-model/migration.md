# マイグレーション手順

## ファイル配置

`db/migrations/05_bingo_staged_unlock.sql` を新規作成する。あわせて `db/create-tables.sql`（空 DB 向けの正本）にも同じ定義を反映する。

> 既存の運用: `npm run db:migrate` は空 DB に `create-tables.sql` を流す。既存 DB への増分適用は `mysql` CLI で `db/migrations/*.sql` を直接実行する。**両方を必ず更新すること。**片方だけ直すと docker 初期化と本番でスキーマが割れる。

## 冪等化

MySQL 8.0 は `ADD COLUMN IF NOT EXISTS` に非対応。既存の `02_add_user_role.sql` / `03_organizer_self_management.sql` と同じく、`information_schema.COLUMNS` を見るストアドプロシージャで包む。テーブル作成は `CREATE TABLE IF NOT EXISTS` でよい。

## 実行順序

1. `booths.is_active` 追加
2. `bingo_cards` → `bingo_cells` → `cell_assignment_logs` の順に CREATE（FK 依存順）
3. `booth_attributes` CREATE
4. `check_ins` に `visit_order` / `cell_id` / INDEX 追加（`cell_id` の FK は `bingo_cells` 作成後）
5. `booth_ratings` に `prompt_context` / `scale` 追加、`rating` の CHECK 削除
6. backfill（下記）

## backfill

### `check_ins.visit_order`

既存行は 0 のままでは分析に使えない。ユーザーごとに `checked_in_at` 昇順で 1 から振り直す。

```sql
SET @uid := '', @n := 0;
UPDATE check_ins ci
JOIN (
  SELECT id,
         @n := IF(@uid = user_id, @n + 1, 1) AS vo,
         @uid := user_id
  FROM check_ins
  ORDER BY user_id, checked_in_at, id
) t ON t.id = ci.id
SET ci.visit_order = t.vo;
```

> MySQL 5.7 にはウィンドウ関数が無いためユーザー変数方式を使う。8.0 なら `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY checked_in_at, id)` でよい。どちらでも結果は同じ。

### 既存参加者のカード

**本番イベントは 2026-10-16 で、それ以前の参加者データはテスト用である。**既存ユーザーへのカード遡及生成は行わない。カードは「無ければ生成する」方式にするため（[03-card-lifecycle/signup.md](../03-card-lifecycle/signup.md)）、既存ユーザーも初回アクセス時に自動で作られる。

### `booth_attributes`

出展者からの取得が未調整（[09-open-questions](../09-open-questions/open-questions.md) Q-6）。**空のまま本番に出ても機能が壊れないこと**を必ず確認する。

## ロールバック

`bingo_*` と `cell_assignment_logs` は DROP で戻せる。`check_ins` / `booth_ratings` への追加列は NULL 許容または DEFAULT 付きなので、旧コードでも INSERT が通る。**先にスキーマだけ本番へ流し、後からアプリをデプロイできる**順序にしてある。
