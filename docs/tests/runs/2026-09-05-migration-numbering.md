# テスト実行記録 — 2026-09-05（db/migrations 番号重複の解消・issue #112）

## 何を

### 対象（src）

- 変更なし。`src/` は本 issue の対象外（`db-migrate.ts` / `db-check.ts` は `db/migrations/` を読まないため無改修）。

### 対象（db / docs）

- `db/migrations/10_onboarding_completed.sql` → `db/migrations/12_onboarding_completed.sql`（`git mv`。中身無改変）
- `db/migrations/README.md`（新規）
- `db/create-tables.sql`（29 行のコメントのみ）
- `docs/operations/production-db-apply.md`（「増分適用を選ばない理由」を書き換え）
- `docs/reference/database.md`（13-15 行の重複注意書きを README への案内に置換）
- `README.md`（89-100 行のツリーを 12 ファイル・21 テーブルに）

### テストコード（tests）

- 追加・変更なし。マイグレーションに関する自動テストは元々存在しない（F17）。

## なぜ

issue #112。`db/migrations/` に `10_` で始まるファイルが 2 つあり適用順が番号から決まらない問題を、
`10_onboarding_completed.sql` → `12_onboarding_completed.sql` のリネームと `db/migrations/README.md` の新設で解消する。

## 実行コマンド・結果（T-1〜T-10）

| # | 内容 | 実行コマンド | 結果 |
|---|---|---|---|
| T-1 | docker init 時に ERROR が 0 行 | `docker logs event-support-mysql \| grep -E "docker-entrypoint-initdb.d/[0-9]+_"` | **未実施（Docker 未起動）** |
| T-2 | 2 経路（docker init / `db:migrate`）のスキーマ同値性（`mysqldump --no-data` diff） | §7-2 手順一式 | **未実施（Docker 未起動）**。代替として静的突合を実施（下記「代替検証」） |
| T-3 | docker init 後のテーブル数が 21 | `SELECT COUNT(*) FROM information_schema.tables ...` | **未実施（Docker 未起動）** |
| T-4 | `card_unlock_events.pair_key` の長さが 16 | `SELECT CHARACTER_MAXIMUM_LENGTH ...` | **未実施（Docker 未起動）** |
| T-5 | `gacha_settings` テーブルが存在 | `SELECT COUNT(*) FROM information_schema.tables ... table_name='gacha_settings'` | **未実施（Docker 未起動）** |
| T-6 | `gacha_coin_uses` に `uk_gacha_coin`・`uk_gacha_idem` が存在 | `SELECT index_name FROM information_schema.statistics ...` | **未実施（Docker 未起動）** |
| T-7 | `users.onboarding_completed_at` が存在 | `SELECT COUNT(*) FROM information_schema.columns ...` | **未実施（Docker 未起動）** |
| T-8 | 二重適用で `db:migrate` が `Skip: ... already has 21 table(s)` / `12_onboarding_completed.sql` の再実行がエラー 0 | `npm run db:migrate` ／ `mysql < db/migrations/12_onboarding_completed.sql` を 2 回 | **未実施（Docker 未起動・node_modules 無し）** |
| T-9 | `db/migrations/` の番号が一意（辞書順＝適用順が成立する前提） | `ls db/migrations/*.sql \| sed -E 's#.*/([0-9]+)_.*#\1#' \| sort \| uniq -d` | **合格。出力 0 行（実測）** |
| T-10 | `npm test` 全 pass・`npm run build` exit 0 | `npm test` / `npm run build` | **未実施（この worktree に node_modules 無し。`npm ci` の実行は司令塔への事前報告が必要なため未実行）** |

## 代替検証（Docker 未起動のため実施した静的突合）

Docker が動いていないため T-1〜T-8 の docker 実測は行わず、代わりに以下の静的チェックをすべて実施した（すべて実測・0 件で合格）。

```bash
# リネーム前ファイル名の残存参照（0件が合格）
git grep -n "10_onboarding_completed" -- . ':!db/migrations/README.md'
→ 0 件（exit=1）

# 新ファイル名の参照箇所（README.md と db/migrations/README.md の2箇所のみ、想定どおり）
git grep -n "12_onboarding_completed" -- .
→ README.md:102, db/migrations/README.md:25 の2件

# 「18 テーブル」の残存（0件が合格）
git grep -n "18 テーブル" -- .
→ 0 件（exit=1）

# 「10_ で始まるファイルが2つ」の残存（0件が合格）
git grep -n "10_ で始まるファイルが2つ" -- .
→ 0 件（exit=1）

# 未改名の10_gacha_coins.sql・11_widen_unlock_pair_key.sqlへの参照が無改変で残っていること（改名していないので存在するのが正）
git grep -n "10_gacha_coins\|11_widen_unlock_pair_key" -- . | wc -l
→ 11件（ADR 0006・gacha仕様書・テスト記録。design書 F13/F14 のとおり無改変）

# 番号の重複が無いこと（T-9）
ls db/migrations/*.sql | sed -E 's#.*/([0-9]+)_.*#\1#' | sort | uniq -d
→ 出力0行

# リネームしたファイルの中身が無改変であること
git diff --cached --stat -M
→ "0 insertions(+), 0 deletions(-)"（rename 100%）
```

`db/create-tables.sql` の DDL 本体（`DROP`/`CREATE`）が無改変であることは
`git diff origin/develop -- db/create-tables.sql | grep -c "^[-+].*DROP\|^[-+].*CREATE"` → `0` で確認済み（別途 §6 チェックリストで実測）。

## 環境

- ブランチ: `fix/migration-numbering`（base: `origin/develop` = `564d3f5`）
- MySQL: 未使用（Docker 未起動のため）
- 関連 PR / Issue: #112

## 結果

- 静的な突合（ファイル名参照・番号一意性・DDL無改変）はすべて合格。
- Docker を用いた実機検証（T-1〜T-8）および `npm test`/`npm run build`（T-10）は本ラン時点では未実施。理由と代替は上記のとおり。

## メモ

- Docker 起動後に T-1〜T-8 を実施し、本ファイルに追記すること。
- `npm ci` の実行可否は司令塔の判断を仰ぐこと（この worktree に `node_modules` が無いため）。
- T-2（`mysqldump --no-data` の2経路diff）で差分が出た場合は本issueでは直さず、設計書 §8-2 のとおり別issue化する。
