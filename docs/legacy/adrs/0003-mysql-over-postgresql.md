# ADR 0003: 永続層を PostgreSQL から MySQL（InnoDB）へ変更する

## 状態

採用

## 日付

2026-05-12

## コンテキスト

当初は PostgreSQL を前提にスキーマを記述していた（`UUID` / `TIMESTAMPTZ` / `JSONB` / 配列型など）。インフラ・運用・チームスキルの都合により **MySQL 8.x（InnoDB）** を採用する。

## 決定

- RDBMS は **MySQL 8.x**、ストレージエンジンは **InnoDB** を全テーブルに明示する
- 主キーは **`CHAR(36)`** とし、UUID は **アプリケーションが生成**して `INSERT` する
- 日時は **`DATETIME`** に統一し、**UTC** はアプリケーション層の規約で統一する
- PostgreSQL の配列型は使わず、タグは **`booth_tags`** テーブル、推薦のブース ID 列挙は **`JSON` 配列**で表現する
- 半構造化フィールドは **`JSON`** 型を使う（旧 `JSONB` の役割）

詳細 DDL とレビュー結果は [database.md](../designs/database.md) を正とする。

**実装（リポジトリ）:** ルートの [docker-compose.yml](../../docker-compose.yml) で開発用 MySQL 8 を起動し、[db/migrations/01_initial_schema.sql](../../db/migrations/01_initial_schema.sql) を初回データディレクトリ作成時に適用する。研究室などの外部 MySQL（例: さくらインターネット）では、同スキーマをマイグレーション手順に従い適用し、接続情報のみ環境変数で差し替える。

## 結果

- 設計ドキュメント（`database.md`, `system-server.md`, リポジトリ README 等）を MySQL 前提に更新する
- ルートの **`db/migrations/`**・**`docker-compose.yml`** を正とし、`docs/README.md` / `AGENTS.md` / `docs/AGENTS.md` / `designs/README.md` / `backend/AGENTS.md` から辿れるようにする
- 将来のマイグレーション・ORM 選定は MySQL の制約（式 `DEFAULT`、`CHECK` のバージョン、`JSON` のインデックス戦略）に合わせる

## 却下した代替案

- **PostgreSQL のまま:** インフラ要件と不一致のため不採用
- **UUID を BINARY(16) で保持:** ストレージ効率は良いが、可観測性とデバッグのしやすさから当面は `CHAR(36)` を採用（必要なら後から ADR で変更）
