# 01. コード修正仕様

各項目は「現象 → 原因 → 修正仕様 → 受け入れ条件」で構成する。
ID（B-1〜B-9）は README の優先順位・PR 分割の単位として使う。

---

## B-1. `npm run db:migrate` が最新スキーマを作成しない 【高】

**現象**
`src/scripts/db-migrate.ts` は `01_initial_schema.sql` のみ適用し、`EXPECTED_TABLES = 10` を検証する。
現在の完全なスキーマは 13 テーブル（10 + `booth_categories` / `organizers` / `audit_logs`）であり、
Docker init を使わずに構築した DB ではオーガナイザー機能・監査ログが動作しない。

**原因**
- `MIGRATION_FILE` が `01_initial_schema.sql` 固定のまま、02〜03 のマイグレーションが追加された
- `02_add_user_role.sql` / `03_organizer_self_management.sql` は `DELIMITER` 構文（mysql CLI 専用）を
  含むため、mysql2 の `multipleStatements` ではそのまま実行できない
- `03_organizer_self_management.sql` 冒頭の「Apply: `npm run db:migrate`」という記述は実態と不一致

**修正仕様**
1. `db-migrate.ts` の空 DB 向け適用は **`db/create-tables.sql` を正とする**
   - `create-tables.sql` は 13 テーブルの完全定義で、`DELIMITER` を含まない
   - 既存の `USE` 行除去処理はそのまま流用する
   - `EXPECTED_TABLES` を `13` に変更する
2. `db/migrations/` は **Docker init（mysql CLI 実行）と既存 DB への増分適用専用**と位置づけ、
   各 SQL の冒頭コメントの「Apply:」欄を実態（Docker init / mysql CLI）に合わせて修正する
3. マイグレーション番号の重複を解消する: `02_booth_categories.sql` を
   `04_booth_categories.sql` へリネームする（`02_add_user_role.sql` は据え置き）
   - ファイル名順で適用される Docker init の順序に影響しないこと（`booth_categories` は
     `booths` / `categories` にのみ依存し、01 の後であればどこでもよい）を確認する
4. `db-migrate.ts` は `DATABASE_URL` 未設定（`SAKURA_PROXY_URL` のみ設定）の場合、
   `parseMysqlUrl(undefined)` で落ちる前に「このスクリプトは直接接続専用」である旨の
   明示的なエラーメッセージで終了する

**受け入れ条件**
- 空 DB に対して `npm run db:migrate` → 13 テーブル作成・正常終了
- `docker compose down -v && docker compose up -d mysql` → init で 13 テーブル
- テーブル数検証（AGENTS.md 記載のワンライナー）が 13 を返す

---

## B-2. ブース PATCH で `tags` のみ指定すると SQL 構文エラー（500）【高】

**現象**
`PATCH /admin/events/:event_id/booths/:booth_id` に `{ "tags": [...] }` だけを送ると 500。

**原因**
`src/routes/v1/admin/admin-booths.ts` — バリデーションは `Object.keys(parsed.data).length` で
通過するが、`tags` は UPDATE 対象の `fields` に積まれないため
`UPDATE booths SET  WHERE id = ? AND event_id = ?` という不正 SQL が実行される。

**修正仕様**
- `fields` が空の場合は UPDATE をスキップし、対象ブースの存在確認
  （`SELECT ... WHERE id = ? AND event_id = ?`）だけ行って 404 判定する
- その後 `replaceBoothTags` → 監査ログ → 最新状態の返却、という既存フローに合流する

**受け入れ条件**
- `tags` のみの PATCH が 200 でタグ置換されること
- 存在しない booth_id への `tags` のみ PATCH が 404 を返すこと

---

## B-3. 同値更新の PATCH が誤って 404 を返す 【高】

**現象**
既存と同じ値で保存（変更なし保存）すると「〜が見つかりません」（404）になる。

**原因**
mysql2 はデフォルトで `CLIENT_FOUND_ROWS` 無効のため、UPDATE の `affectedRows` は
「値が実際に変わった行数」を返す。`affectedRows === 0` を存在チェックに流用している
以下の箇所がすべて該当する（さくらプロキシ経由の PDO も同じ既定挙動）。

- `src/routes/v1/admin/events.ts`（PATCH イベント）
- `src/routes/v1/admin/admin-booths.ts`（PATCH ブース）
- `src/routes/v1/admin/categories.ts`（PATCH カテゴリ）
- `src/routes/v1/admin/survey-questions.ts`（PATCH 設問）

**修正仕様**
- 存在確認は UPDATE の前に `SELECT id ... LIMIT 1` で行い、無ければ 404 を返す
  （ADR 0001「INSERT 前に SELECT で確認」と同じ方針に PATCH も揃える）
- UPDATE 後の `affectedRows` による 404 判定は撤去する
- DELETE 系の `affectedRows` 判定は正しい挙動のため変更しない

**受け入れ条件**
- 既存と同一の値で PATCH → 200 で現在値が返る
- 存在しない ID への PATCH → 404

---

## B-4. イベント作成のトランザクション分岐がデッドコード 【中】

**現象**
`POST /organizer/events`（`src/routes/v1/organizer/events.ts`）の
`app.db.getConnection?.()` 分岐は常に `undefined` になり、トランザクションは一度も使われない。
events INSERT 成功後に users INSERT が失敗すると、初期管理者のいない孤児イベントが残る。

**原因**
`DbClient`（`src/db/client.ts`）にも `createPool` のラッパー（`src/db/pool.ts`）にも
`getConnection` が存在しない。

**修正仕様**
1. `DbClient` にオプショナルの `getConnection?()` を追加し、`pool.ts` のラッパーで
   mysql2 の `pool.getConnection()` を委譲実装する（`http-proxy.ts` は未実装のまま）
2. これによりローカル mysql2 経路では既存のトランザクション分岐が実際に機能する
3. 非トランザクション経路（さくらプロキシ）には補償処理を追加する:
   users INSERT が失敗した場合、作成済み events 行を `DELETE FROM events WHERE id = ?` で
   削除してからエラーを再送出する（`ON DELETE CASCADE` により中間データも消える）

**受け入れ条件**
- ローカル mysql2 で users INSERT を強制失敗させた場合、events 行が残らない（ロールバック）
- プロキシ経路（`proxy:mock`）で同様に失敗させた場合、補償削除により events 行が残らない

---

## B-5. オーガナイザー登録が環境変数未整備で常に 403 【中】

**現象**
`ORGANIZER_SIGNUP_MODE` の既定は `invite`。`ORGANIZER_REGISTRATION_KEY` 未設定だと
`POST /organizer/auth/register` は常に 403 となり、登録手段が存在しない。
かつ `.env.example`・`AGENTS.md` にこれら 3 変数（`FRONTEND_BASE_URL` 含む）の記載がない。

**修正仕様**
1. `.env.example` に以下を追記する（生成コマンド例・用途コメント付き）:
   - `ORGANIZER_REGISTRATION_KEY`（invite モード時の `X-Organizer-Key` 検証キー）
   - `ORGANIZER_SIGNUP_MODE`（`invite` | `open`、既定 `invite`）
   - `FRONTEND_BASE_URL`（イベント作成時に発行する参加者/運営 URL のベース。
     未設定時は `CORS_ORIGIN` の先頭オリジンを使用する現行仕様を明記）
2. `invite` モードで `ORGANIZER_REGISTRATION_KEY` 未設定のとき、起動時（`loadConfig`）に
   警告ログを出す（起動は継続。登録を封鎖したい運用を許容するため）

**受け入れ条件**
- `.env.example` をコピーしただけの環境で、キーを設定すればオーガナイザー登録が通る
- AGENTS.md の環境変数表と `.env.example` の項目が一致する（02-docs-consistency.md D-2 と連動）

---

## B-6. 推薦選択で `selected_booth_id` を検証していない 【中】

**現象**
`POST /events/:event_id/recommendations/:recommendation_id/select`
（`src/routes/v1/recommendations.ts`）は、提示していないブース ID・他イベントの
ブース ID でも保存でき、推薦分析（acceptance_rate 等）が汚れる。

**修正仕様**
- 対象 recommendation の `offered_booth_ids` を取得し、`selected_booth_id` が
  含まれない場合は 422 `VALIDATION_ERROR`（「提示された推薦に含まれないブースです」）を返す

**受け入れ条件**
- offered に含まれる ID → 200 / 含まれない ID → 422

---

## B-7. 監査ログ一覧の `JSON.parse` が保護されていない 【低】

**現象**
`src/routes/v1/admin/audit-logs.ts` の `JSON.parse(r.detail)` に try/catch がなく、
detail が不正 JSON の行が 1 件でもあると一覧全体が 500 になる。

**修正仕様**
- パース失敗時は `detail: null`（または生文字列）でフォールバックし、一覧は返す

**受け入れ条件**
- detail に不正文字列を直接投入した行があっても一覧 API が 200 を返す

---

## B-8. API キー比較のタイミングセーフ化 【低】

**対象**
- `X-Admin-Key`（`src/routes/v1/auth.ts`）
- `X-Api-Key`（`src/routes/v1/ops.ts`）
- `X-Organizer-Key`（`src/routes/v1/organizer/auth.ts`）

**修正仕様**
- `crypto.timingSafeEqual` を使った比較ヘルパー（例: `src/lib/safe-compare.ts`）を新設し、
  上記 3 箇所の `!==` 比較を置き換える（長さ不一致は即 false。例外を投げない）

**受け入れ条件**
- 正しいキーで従来どおり通り、誤ったキーで 401/403 が返る（挙動不変）
- ヘルパーの単体テストを `tests/unit/` に追加する

---

## B-9. ログインのユーザー列挙耐性（任意・低）

**現象**
`POST /auth/login` はユーザー不在時に bcrypt 比較をスキップするため、
応答時間からメールアドレスの存在有無を推測できる。

**修正仕様（任意）**
- ユーザー不在時もダミーハッシュに対して `bcrypt.compare` を 1 回実行してから 401 を返す

**受け入れ条件**
- 認証失敗のレスポンス（メッセージ・ステータス）は現行と同一
