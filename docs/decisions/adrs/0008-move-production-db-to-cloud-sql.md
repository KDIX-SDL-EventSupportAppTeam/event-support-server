# 0008. 本番DBをさくらプロキシから Cloud SQL へ移す

- 日付: 2026-09-16
- ステータス: 承認

## コンテキスト

本番DBは先生が所有するさくら Standard の MySQL を使っていた。さくら Standard は外部からの
MySQL 接続を許さないため、さくら上に HTTP ラッパー API を置き、Cloud Run からは
`SAKURA_PROXY_URL` 経由で 1 リクエスト = 1 SQL を投げていた（`src/db/http-proxy.ts`）。

この経路には次の制約があった。

- トランザクションも行ロックも使えない。排他は条件付き UPDATE の `affectedRows` に頼る
- MySQL のエラーが 500 に潰される（[ADR 0001](./0001-sakura-proxy-error-masking.md)）
- マルチステートメントを流せないため、スキーマ適用は先生に phpMyAdmin で実行してもらうしかない
- 適用前ダンプも先生の手作業で、当日の復旧が先生の在席に依存する

## 決定

本番DBを GCP の **Cloud SQL for MySQL 8.0**（`event-support-app:asia-northeast1:event-support-db`）へ移す。

- Cloud Run からは `--add-cloudsql-instances` で Unix ソケット `/cloudsql/<接続名>` に繋ぐ。
  `DATABASE_URL` の `?socket=` を `src/db/parse-mysql-url.ts` が `socketPath` に変換する
- 接続は mysql2 の直接接続経路（`src/db/pool.ts`）。ローカル docker（`mysql:8.0`）と同じ経路になる
- サーバーは `default_time_zone=+00:00`、`character_set_server=utf8mb4`。`pool.ts` の
  `timezone: 'Z'` と `DEFAULT CURRENT_TIMESTAMP` の評価を一致させるため
- スキーマ適用は `cloud-sql-proxy` 経由で `npm run db:migrate` を流す。先生への依頼は不要になる

**ADR 0001 の書き方（INSERT 前の SELECT 確認・条件付き UPDATE）は当面維持する。**
`src/db/http-proxy.ts` と `getConnection` 非対応時のフォールバックも残す。
さくらへ環境変数だけで切り戻せる状態を、Cloud SQL で本番を1回通すまで保つため。

## 結果・トレードオフ

- 得るもの: トランザクション（`getConnection` 経路）が本番で有効になる。エラーがマスクされない。
  HTTP 往復が消える。スキーマ適用とダンプを自分たちで行える
- 失うもの: Cloud SQL は Cloud Run と違いゼロスケールしない。インスタンスを動かしている間は常時課金される
- 切り戻し: `cloudbuild.yaml` の env を `SAKURA_PROXY_URL` に戻して再デプロイすれば旧経路に戻る。
  ただし切替後に Cloud SQL 側へ書き込まれたデータはさくらに無いので、**書き込みが始まった後は実質戻せない**
- 旧本番（さくら）のデータは移行していない。第3回以前の本番データは入っていなかったため
