# 実装規約（TypeScript / Fastify）

## TypeScript

- strict。`any` は避け、DB 行は必要最小限の型アサーションに留める
- **ESM**: 相対 import には `.js` 拡張子を付ける（`from '../../lib/response.js'`）
- パスエイリアス `@/` は使わない。`src/` 内は相対パス
- ルート間の相互 import 禁止。共有するものは `lib/` / `plugins/` / `db/` に置く
- 設定は `loadConfig()`（`src/config.ts`）経由。ルート内で `process.env` を直接読まない
- Fastify の型拡張（`req.jwtUser` / `app.db`）は `src/types/fastify.d.ts` を更新する

## ルート

- 1 ドメイン = 1 ファイル。`app.ts` で個別に register する
- 参加者向けは `const pre = [requireBearerAuth, requireEventMatchesJwt]` を共通化
- レスポンスは `sendOk(reply, data)` / `sendFail(reply, status, code, message)` を使う。
  `reply.send` を直接呼ばない
- リクエストの body / query は **zod** で `safeParse`。失敗は `422` + `VALIDATION_ERROR`
- 未存在は `404` + `NOT_FOUND`、一意制約違反は `409` + `CONFLICT`

## DB

- SQL は `app.db.query` / `app.db.execute`。ユーザー入力を SQL 文字列に連結しない
- クライアントから来た日時は `isoToMysqlUtc` で UTC に変換してから保存する
- 返却する日時は MySQL DATETIME を ISO8601（末尾 `Z`）に整形する

### 本番 DB 特有の制約（必ず守る）

本番の DB アクセスはさくら上のラッパー API への HTTP プロキシ経由で、**1 リクエスト = 1 SQL**。
トランザクションも行ロックも存在しない。

- **`SELECT ... FOR UPDATE` は使えない。** 排他は条件付き UPDATE の `affectedRows` で行う
- **INSERT の前に SELECT で重複を確認する。** プロキシは重複キーエラーを 500 に潰すため
  `ER_DUP_ENTRY` を受け取れない（[ADR 0001](../decisions/adrs/0001-sakura-proxy-error-masking.md)）
- 往復回数を減らす。複数行 INSERT・`CASE WHEN` によるまとめ UPDATE を使う

## 命名

ドメイン用語は [docs/ubiquitous-language.md](../ubiquitous-language.md) を正本とする。
用語を追加・変更したら、コードと同じコミットでこのファイルも更新する。
