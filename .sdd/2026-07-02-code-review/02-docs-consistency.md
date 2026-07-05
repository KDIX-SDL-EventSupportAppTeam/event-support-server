# 02. ドキュメント同期仕様

コードが先行し、正本ドキュメントが旧体系（`role: admin` 時代）のまま残っている箇所を同期する。
ID（D-1〜D-6）単位で PR を分割してよいが、**D-1（ユビキタス言語）を必ず最初に確定させる**こと。
他の修正はすべて D-1 の語彙を使って記述するため。

---

## D-1. ユビキタス言語のロール体系刷新 【最優先】

**対象**: `docs/ubiquitous-language.md`

**現状の乖離**
- 「運営 | `admin` / `organizer` | … JWT の `role: admin` で識別する」
- 「ロール | `role` | … `participant`（参加者）または `admin`（運営）」

実装は `participant` / `manager` / `viewer` の 3 ロール + イベント横断の
オーガナイザー（`scope: 'organizer'` の別系統 JWT、`event_id` を持たない）。

**修正仕様**
1. `.sdd/README.md`「ユビキタス言語の追加提案」の 8 用語
   （主催者 / Organizer、主催者ポータル、初期管理者自動発行、運営管理者 / Manager、
   運営閲覧者 / Viewer、スタッフ招待、監査ログ、参加者 URL / 運営 URL）を正式採用して追記する
2. 既存の「運営」「ロール」行を新体系に書き換える:
   - ロール: `participant` / `manager`（編集可）/ `viewer`（閲覧のみ）
   - 「運営」は manager と viewer の総称であること、旧 `admin` は `manager` に移行済み
     （`03_organizer_self_management.sql` の UPDATE 文）であることを注記する
3. オーガナイザー JWT（`sub` + `scope: 'organizer'`、`event_id` なし、30 日有効）と
   参加者/運営 JWT（`sub` + `event_id` + `role`、イベント終了 +24h 有効）の 2 系統を
   「認証・ユーザー」節に明記する

**受け入れ条件**
- `docs/ubiquitous-language.md` 内に旧定義（`role: admin` が現行仕様であるかのような記述）が残らない
- フロントエンド側 `docs/ubiquitous-language.md` にも同じ用語を反映する
  （frontend の 2026-07-02-code-review D-1 と同時に実施）

---

## D-2. AGENTS.md の実装乖離の解消

**対象**: `AGENTS.md`

**修正仕様**

1. **環境変数表**に以下を追加する（01-bugfixes.md B-5 と連動）:

   | 変数名 | 必須 | 説明 |
   |--------|------|------|
   | `FRONTEND_BASE_URL` | — | イベント作成時に発行する参加者/運営 URL のベース。未設定時は `CORS_ORIGIN` の先頭 |
   | `ORGANIZER_REGISTRATION_KEY` | invite 時 ✅ | オーガナイザー登録の `X-Organizer-Key` 検証キー |
   | `ORGANIZER_SIGNUP_MODE` | — | `invite`（既定）\| `open` |

   また `ADMIN_REGISTRATION_KEY` の必須欄を実装（`z.string().min(1)`、開発でも必須）に合わせて修正する。

2. **実装済みエンドポイント表**に不足分を追加する:
   - `POST /api/v1/organizer/auth/register`（`X-Organizer-Key`、invite 時）
   - `POST /api/v1/organizer/auth/login`
   - `GET /api/v1/organizer/events`（Bearer organizer。Phase 2 スタブで空配列を返す旨を注記）
   - `POST /api/v1/organizer/events`（Bearer organizer。イベント + 初期管理者 + URL 発行）
   - `POST /api/v1/organizer/events/:event_id/staff`（Bearer organizer、所有イベントのみ）
   - `GET /api/v1/admin/events/:event_id`・`PATCH 同`（Bearer manager ※GET は viewer 可）
   - `GET /api/v1/admin/events/:event_id/audit-logs`（Bearer staff、ページネーション付き）
   - `DELETE /api/v1/admin/events/:event_id/event-data`（Bearer manager、確認文字列必須）
   - `POST /api/v1/admin/events/:event_id/sample-data/generate`・`DELETE 同 /sample-data`
   - 認証欄の表記を「Bearer（`role: admin`）」から「Bearer（manager）/（staff = manager+viewer）」へ統一

3. **認証の仕組み**節を書き換える:
   - `requireBearerAuth` → `requireEventMatchesJwt` → `requireManager` / `requireStaff` の
     実在する preHandler 名で説明する
   - 「`requireAdminRole` への共通化は Issue #8 予定」の記述を削除する（実装済み）
   - `requireOrganizer`（organizer JWT 検証）を追記する
   - `requireAdmin` は `requireManager` の後方互換エイリアスである旨を注記する

4. **DB 節**を更新する:
   - 「スキーマの正は `db/migrations/01_initial_schema.sql`（10 テーブル）」→
     「完全なスキーマの正は `db/create-tables.sql`（**13 テーブル**）。増分は `db/migrations/`（4 ファイル）」
   - テーブル数確認コマンドの期待値を `10` → `13` に修正する

5. **WebSocket 節**: 運営ルーム参加条件を「`role: admin`」ではなく
   「`manager` または `viewer`」と明記する。

**受け入れ条件**
- AGENTS.md の全エンドポイント行が `src/routes/v1/` の実装と 1:1 で対応する
- 環境変数表と `src/config.ts` の envSchema・`.env.example` の 3 者が一致する

---

## D-3. README.md のディレクトリ構造・注記の更新

**対象**: `README.md`

**修正仕様**
1. ディレクトリ構造の図に不足分を追加する:
   - `routes/v1/organizer/`（auth / events / staff）
   - `routes/v1/admin/` の内訳（dashboard 以外に 9 ファイルある旨、または代表例）
   - `plugins/socket.ts`
   - `lib/audit.ts`・`lib/url.ts`・`lib/json-array.ts`・`lib/event-data/`・`lib/sample-data/`
   - `scripts/` の全体（db-check / seed-prod / seed-sample / clear-sample / clear-event）
   - `db/migrations/` の 4 ファイル（B-1 のリネーム後の名前で記載）
2. 「現時点では運営向けエンドポイントの一部（dashboard）のみ分離済み。残りは Issue #8 で追加予定」の
   Note を削除する（運営 CRUD 分離は完了済み）
3. アーキテクチャ図・「担当すること」に WebSocket（実装済み）とオーガナイザー機能を反映する
   （「Issue #8」参照の削除）

**受け入れ条件**
- README の構造図に載っている全パスが実在し、`src/` 直下の主要ファイルが漏れなく載る

---

## D-4. docs/orders の完了リネーム運用の追いつき

**対象**: `docs/orders/`

**修正仕様**
- `2026-06-16-依頼-運営CRUD-ダッシュボード-WebSocket実装.md` は AGENTS.md「次にやること」で
  完了扱いのため、`2026-06-16-完了-…` にリネームし、末尾に完了日・対応 PR を追記する
- `2026-06-16-依頼-管理画面クラスタリング仕様.md` は実装状況を確認し、
  完了なら同様にリネーム、未着手なら AGENTS.md「次にやること」に項目として復元する
- `docs/orders/README.md` の一覧を更新する

---

## D-5. コード内コメントの参照先修正 【低】

- `src/scripts/db-migrate.ts`・`db/migrations/*.sql` 冒頭の「Apply:」コメント
  （B-1 の修正仕様 2 と同一。二重対応不要、B-1 側で実施）
- `01_initial_schema.sql` 冒頭の「keep in sync with docs/designs/database.md §11」は
  実在パス（`docs/legacy/designs/database.md`）に修正する

---

## D-6. AGENTS.md「次にやること」の更新

本 SDD の対応 PR を作成するたびに、AGENTS.md「次にやること」へ
残項目（B-x / D-x の未完了分）を反映する。全項目完了時は本 SDD への参照ごと削除してよい。
