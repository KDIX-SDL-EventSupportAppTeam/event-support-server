---
状態: 確定
最終更新: 2026-09-16
---

# 本番DBへのスキーマ適用（Cloud SQL）

本番DBは Cloud SQL for MySQL 8.0（[ADR 0008](../decisions/adrs/0008-move-production-db-to-cloud-sql.md)）。
スキーマ適用・バックアップ・復元はすべて自分たちで行える。**先生への依頼は不要。**

| 項目 | 値 |
|---|---|
| プロジェクト | `event-support-app` |
| インスタンス | `event-support-db`（接続名 `event-support-app:asia-northeast1:event-support-db`） |
| DB / ユーザー | `event_support` / `app` |
| フラグ | `character_set_server=utf8mb4`、`default_time_zone=+00:00`（**必須**。`pool.ts` の `timezone: 'Z'` と揃える） |

> コマンドは PowerShell 前提。カンマを含む引数（`--database-flags=a=b,c=d` 等）は**全体をクォートする**。
> しないと PowerShell が配列として解釈し、カンマがスペースに化ける。

## 1. ローカルから Cloud SQL に繋ぐ

`cloud-sql-proxy` を起動し、`127.0.0.1:3307` で TCP 接続する（ローカル docker の 3306 と衝突させない）。
Windows 版バイナリは GitHub Releases の `cloud-sql-proxy.x64.exe`。

```powershell
gcloud auth application-default login
& "$HOME\bin\cloud-sql-proxy.exe" --port 3307 event-support-app:asia-northeast1:event-support-db
```

別ターミナルで `.env` を次の形にする。**`SAKURA_PROXY_URL` は書かない**（あると `npm run dev` がさくらに繋がる）。

```
DATABASE_URL=mysql://app:<password>@127.0.0.1:3307/event_support
JWT_SECRET=<任意>
ADMIN_REGISTRATION_KEY=<任意>
```

`db:migrate` / `db:check` も `loadConfig()` を通るので、`JWT_SECRET` と `ADMIN_REGISTRATION_KEY` は値が何であれ必要。

## 2. 事前バックアップ（必須）

**適用前に必ず取る。**

```powershell
gcloud sql backups create --instance=event-support-db --project=event-support-app --description="before-schema-apply"
```

## 3. 適用

```powershell
npm run db:check    # 接続できて tables: 0 であること
npm run db:migrate  # Migration OK: 25 tables created
npm run db:check    # OK: all 25 tables exist
```

`db:migrate` は**空の DB にしか流せない**（テーブルが1つでもあれば中断する）。
作り直すときは DB ごと消して作り直す。**データは消える。**

```powershell
gcloud sql databases delete event_support --instance=event-support-db --project=event-support-app
gcloud sql databases create event_support --instance=event-support-db --project=event-support-app --charset=utf8mb4 --collation=utf8mb4_general_ci
```

## 4. 事前アンケートの設問投入（イベント作成の後）

イベント本体は organizer 画面（`POST /organizer/events`）で作る。**設問はイベント作成では入らない。**
本番の設問セット（必須5問＋任意1問）は `db/migrations/16_pre_survey_questions.sql` にしか無い。

このファイルは**実行時点で存在するイベント全件**に設問を入れる。再実行は無害（`question_key` で存在確認する）。
イベントを作ったら、そのたびに1回流す。mysql クライアントが無ければ docker で代用できる。

```powershell
Get-Content db/migrations/16_pre_survey_questions.sql -Raw | docker run --rm -i mysql:8.0 mysql -h host.docker.internal -P 3307 -u app -p<password> event_support
```

`npm run db:seed:prod` は**使わない。** 既定の設問が旧形式（`question_key` 無し）で、分析・推薦側との契約を満たさない。

## 5. ロールバック

§2 で取ったバックアップから復元する。**インスタンス全体が巻き戻る**（バックアップ以降のデータは消える）。

```powershell
gcloud sql backups list --instance=event-support-db --project=event-support-app
gcloud sql backups restore <BACKUP_ID> --restore-instance=event-support-db --project=event-support-app
```

当日トラブル時の判断基準は [rollback.md](rollback.md)。

## 実行のタイミング

| 対象 | いつ | 備考 |
|---|---|---|
| リハーサル用DB | リハーサルの前 | 本番と**別の DB**（別インスタンスか別 database）で先に手順を通す |
| 本番DB | イベント前日まで | 当日の朝は行わない（失敗したとき戻す時間が無い） |

## 起きてはいけないこと

- **バックアップを取らずに適用すること**
- **`.env` に `SAKURA_PROXY_URL` を残したまま作業すること**
- **本番DBでリハーサルを行うこと**（`docs/specs/bingo-dynamic-unlock/00-must-do.md`）
- **Cloud Run に `--update-env-vars` でデプロイすること**（`SAKURA_PROXY_URL` が残り、無言でさくら経路に戻る）
