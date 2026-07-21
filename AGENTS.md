# event-support-server — Fastify REST API

概要・ディレクトリ構造・起動手順・関連リポジトリは [README.md](./README.md) を参照。

---

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `DATABASE_URL` | △ | `mysql://user:pass@host:3306/dbname`。`SAKURA_PROXY_URL` 未設定時は必須 |
| `SAKURA_PROXY_URL` | △ | さくら上ラッパー API のベース URL（例: `https://example.sakura.ne.jp/proxy`）。設定時は HTTP プロキシ経由で DB アクセス |
| `SAKURA_PROXY_KEY` | プロキシ使用時 ✅ | ラッパー API 認証キー（`X-Proxy-Key` ヘッダー。本番は Secret Manager） |
| `JWT_SECRET` | ✅ | JWT 署名キー（本番は 32 文字以上のランダム文字列） |
| `WEBHOOK_API_KEY` | 本番 ✅ | Google Apps Script から受け取る Webhook 認証キー（開発は空でも可） |
| `ADMIN_REGISTRATION_KEY` | ✅ | 運営アカウント登録（`POST /auth/register/admin`）の `X-Admin-Key` 検証キー。開発でも必須 |
| `FRONTEND_BASE_URL` | — | イベント作成時に発行する参加者/運営 URL のベース。未設定時は `CORS_ORIGIN` の先頭オリジンを使用する |
| `ORGANIZER_REGISTRATION_KEY` | invite 時 ✅ | オーガナイザー登録（`POST /organizer/auth/register`）の `X-Organizer-Key` 検証キー |
| `ORGANIZER_SIGNUP_MODE` | — | `invite`（既定・キー必須）\| `open`（誰でも登録可）\| `disabled`（登録停止・410、本番推奨） |
| `RECOMMENDER_URL` | — | 推薦エンジンの URL（未設定・失敗時は内部ランダム推薦にフォールバック） |
| `CORS_ORIGIN` | — | 許可するオリジン（カンマ区切り。未設定時は `http://localhost:5173`） |
| `PORT` | — | リッスンポート（既定: `3000`。Cloud Run では `$PORT` が自動注入される） |

> `DATABASE_URL` と `SAKURA_PROXY_URL` の**どちらか一方**は必須。本番（さくら Standard）は外部から MySQL 直接接続不可のため、通常は `SAKURA_PROXY_URL` + `SAKURA_PROXY_KEY` を使う。

### 本番（Cloud Run）向けの渡し方

- `JWT_SECRET` / `WEBHOOK_API_KEY` / `SAKURA_PROXY_KEY` / `ADMIN_REGISTRATION_KEY` は **Secret Manager** に登録し、Cloud Run の `--set-secrets` で渡す
- `SAKURA_PROXY_URL` / `PORT` / `CORS_ORIGIN` / `RECOMMENDER_URL` は `--set-env-vars` で渡す
- 本番（さくら Standard）では `SAKURA_PROXY_URL` 経由が前提。`DATABASE_URL` は Cloud Run から不要（ラッパー API がさくら内から MySQL に接続）
- 値はリポジトリにコミットしない（`.env` は `.gitignore` 済み）
- 詳細手順: [docs/deploy/cloud-run.md](./docs/deploy/cloud-run.md)

### シークレットの生成コマンド

```bash
# JWT_SECRET（48 バイト ≒ 64 文字）
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# WEBHOOK_API_KEY（32 バイト ≒ 43 文字）
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### `CORS_ORIGIN` 運用フロー

`CORS_ORIGIN` はフロントの本番ドメインに依存するので、デプロイの順序に注意:

1. **初回**: 仮の値（例: フロントの Firebase Hosting 既定 URL）で server をデプロイ
2. フロントを `VITE_API_BASE_URL=<server の URL>` でビルド・デプロイ
3. フロントの **本番 URL が確定** したら、`CORS_ORIGIN` を更新して server を再デプロイ
   ```bash
   gcloud run services update event-support-server \
     --region=asia-northeast1 \
     --update-env-vars="CORS_ORIGIN=https://<frontend-host>"
   ```
4. 複数の許可オリジン（例: `web.app` + `firebaseapp.com`）を許す場合はカンマ区切り

> プレビュー/ステージング環境を持つときは、ステージング側の CORS と本番側を別サービスとして分けるのが安全。

---

## 実装済みエンドポイント

| メソッド | パス | 認証 | 説明 |
|----------|------|------|------|
| GET | `/health` | — | 死活監視 |
| POST | `/api/v1/auth/register` | — | 参加者登録 |
| POST | `/api/v1/auth/register/admin` | `X-Admin-Key` | 運営アカウント登録 |
| POST | `/api/v1/auth/login` | — | ログイン・JWT 発行 |
| GET | `/api/v1/events/:event_id/survey/questions` | Bearer | アンケート設問取得 |
| POST | `/api/v1/events/:event_id/survey/answers` | Bearer | アンケート回答送信 |
| GET | `/api/v1/events/:event_id/booths` | Bearer | ブース一覧（カテゴリフィルタ可） |
| GET | `/api/v1/events/:event_id/booths/:booth_id` | Bearer | ブース詳細 |
| POST | `/api/v1/events/:event_id/checkins` | Bearer | チェックイン（QR / 手動コード） |
| GET | `/api/v1/events/:event_id/checkins` | Bearer | 自分のチェックイン履歴 |
| POST | `/api/v1/events/:event_id/checkins/:checkin_id/rating` | Bearer | 評価送信（+comment。空白のみは NULL 正規化、再送信は 409） |
| GET | `/api/v1/events/:event_id/recommendations` | Bearer | 推薦取得（`RECOMMENDER_URL` 設定時は外部推薦、未設定/失敗時はランダム） |
| POST | `/api/v1/events/:event_id/recommendations/:recommendation_id/select` | Bearer | 推薦選択 |
| POST | `/api/v1/webhook/booths/sync` | `X-Api-Key` | ブース情報同期（Google Forms） |
| POST | `/api/v1/organizer/auth/register` | `X-Organizer-Key`（invite 時） | オーガナイザー登録 |
| POST | `/api/v1/organizer/auth/login` | — | オーガナイザーログイン・JWT 発行 |
| GET | `/api/v1/organizer/events` | Bearer（organizer） | 所有イベント一覧（統計・URL 付き、`date_start DESC`） |
| GET | `/api/v1/organizer/events/:event_id` | Bearer（organizer、所有イベントのみ） | イベント詳細（非所有・不存在は 403） |
| POST | `/api/v1/organizer/events` | Bearer（organizer） | イベント作成 + 初期管理者自動発行 + 参加者/運営 URL 発行 |
| GET | `/api/v1/organizer/events/:event_id/staff` | Bearer（organizer、所有イベントのみ） | 運営スタッフ一覧（招待順） |
| POST | `/api/v1/organizer/events/:event_id/staff` | Bearer（organizer、所有イベントのみ） | 運営スタッフ招待（manager/viewer） |
| PATCH | `/api/v1/organizer/events/:event_id/staff/:user_id` | Bearer（organizer、所有イベントのみ） | スタッフのロール変更（最後の manager ガード） |
| DELETE | `/api/v1/organizer/events/:event_id/staff/:user_id` | Bearer（organizer、所有イベントのみ） | スタッフ削除（最後の manager ガード） |
| DELETE | `/api/v1/organizer/events/:event_id/event-data` | Bearer（organizer、所有イベントのみ、確認文字列必須） | イベントデータ全削除（監査ログ記録） |
| GET | `/api/v1/events/:event_id/public` | — | 公開イベント情報（名前・日程・会場・アンケートURL） |
| POST | `/api/v1/admin/events/:event_id/exhibitors/bulk` | Bearer（manager） | 出展者アカウント一括登録（行単位の成功/失敗を返す） |
| GET | `/api/v1/events/:event_id/exhibitor/booths` | Bearer | 出展者の担当ブース一覧（exhibitor 以外は空で返す） |
| GET | `/api/v1/events/:event_id/exhibitor/booths/:booth_id/stats` | Bearer（担当ブースのみ、DB 認可） | 出展者向け集計（チェックイン数・時間帯別・評価分布・コメント） |
| GET | `/api/v1/events/:event_id/exhibitor/booths/:booth_id/comments` | Bearer（担当ブースのみ、DB 認可） | 出展者向けコメント一覧（limit/offset。匿名・is_hidden 除外） |
| GET / PATCH | `/api/v1/admin/events/:event_id` | Bearer（manager。GET は viewer も可） | イベント情報取得・更新 |
| GET | `/api/v1/admin/events/:event_id/audit-logs` | Bearer（staff = manager+viewer） | 監査ログ一覧（ページネーション付き） |
| GET | `/api/v1/admin/events/:event_id/booths/:booth_id/comments` | Bearer（staff = manager+viewer） | 運営向けコメント一覧（limit/offset。`is_hidden`・表示名を含む） |
| GET | `/api/v1/admin/events/:event_id/booths` | Bearer（staff = manager+viewer） | 運営向けブース一覧（`sort=checkin_count\|avg_rating\|name`・`order=asc\|desc`、既定 `checkin_count desc`。不正値は既定値にフォールバック） |
| POST / DELETE | `/api/v1/admin/events/:event_id/sample-data` | Bearer（manager） | サンプルデータ生成・削除 |
| GET | `/api/v1/admin/events/:event_id/dashboard` | Bearer（staff） | 運営ダッシュボード（簡易集計） |
| GET | `/api/v1/admin/events/:event_id/analytics/{booths,participants,checkins,recommendations}` | Bearer（staff） | 分析データ取得 |
| CRUD | `/api/v1/admin/events/:event_id/{categories,booths,survey-questions}` ほか | Bearer（manager。GET 系は staff） | カテゴリ/ブース/設問の運営 CRUD・参加者一覧 |

運営 CRUD の各エンドポイントは `src/routes/v1/admin/` 配下に分割、オーガナイザー系は `src/routes/v1/organizer/` 配下（`app.ts` の登録順を参照）。

### WebSocket（socket.io）

- 接続時に JWT（`auth.token`）で認証し、`event:<event_id>`（全員）/ `event:<event_id>:admin`（`manager` または `viewer` のみ）ルームへ参加
- サーバー → クライアントのイベント:
  - `checkin:new` — チェックイン発生時に運営ルームへ配信
  - `rating:new` — 評価送信時に運営ルームへ配信
- 配信が複数インスタンスで届かない問題を避けるため Cloud Run は 1 インスタンス固定（[ADR 0002](./docs/adrs/0002-cloud-run-single-instance-for-websocket.md)）

> 一意制約（チェックイン/評価/メール）は、さくらプロキシがエラーを 500 に潰す都合上 INSERT 前に SELECT で重複確認する（[ADR 0001](./docs/adrs/0001-sakura-proxy-error-masking.md)）。
> 詳細は [docs/legacy/designs/api.md](./docs/legacy/designs/api.md) を参照。

---

## 認証の仕組み

```
POST /api/v1/auth/login → JWT 発行（payload: { sub, event_id, display_name, role }）
POST /api/v1/organizer/auth/login → 主催者 JWT 発行（payload: { sub, scope: 'organizer' }）
        ↓
以降のリクエストに Authorization: Bearer <token> を付与
        ↓
requireBearerAuth         → トークンの署名・有効期限を検証
requireEventMatchesJwt    → URL の :event_id と JWT の event_id が一致するか検証
requireManager            → role: manager（旧 admin 含む）を要求
requireStaff              → role: manager または viewer を要求
requireOrganizer          → 主催者 JWT（scope: 'organizer'）を検証
```

`requireAdmin` は `requireManager` の後方互換エイリアス。  
ペイロードの詳細は [docs/ubiquitous-language.md](./docs/ubiquitous-language.md) § 認証・ユーザーを参照。

出展者（`role: 'exhibitor'`）の認可は JWT に依存せず、リクエストごとに `users.role` と `exhibitor_booths` を DB で確認する（`src/lib/exhibitor.ts`）。一括登録で既存参加者に後付けでロールを付与するケースがあり、発行済み JWT が古いままでも正しく判定するため。

---

## DB

完全なスキーマの正は `db/create-tables.sql`（**15 テーブル**）。増分は `db/migrations/`（8 ファイル）。  
起動手順・Docker init と `db:migrate` の使い分けは [README.md § ローカル開発](./README.md#ローカル開発) を参照。  
設計の解説は [docs/legacy/designs/database.md](./docs/legacy/designs/database.md) を参照。

```bash
# テーブル数確認
docker exec -it event-support-mysql \
  mysql -u app -pappsecret event_support \
  -NBe "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='event_support';"
# 15 が返ること
```

さくら等への引き渡し時: `db/create-tables.sql` を渡す（先頭の `USE` を実 DB 名に書き換えて全文実行）。

---

## フロントエンドとの接続確認

```bash
# フロントエンド側（event-support-frontend）で
# VITE_MOCK_API=false / VITE_DATA_SOURCE=api を設定して npm run dev

# dev@example.com / password123 でログイン（db:seed 済みの場合）
# または /register で新規登録
```

開発用シードの定数は [docs/tests/fixtures/dummy-login.md](./docs/tests/fixtures/dummy-login.md)（`src/scripts/seed-dev.ts` と同期）。

---

## テスト

| 場所 | 役割 |
|------|------|
| [`tests/`](./tests/) | Vitest のテストコード（`unit/`・`integration/`）。**ここにまとめる** |
| [`docs/tests/`](./docs/tests/) | 実行記録（`runs/`）・フィクスチャ（`fixtures/`） |

- `src/` 内に `*.test.ts` を置かない
- テスト追加・実行後は [docs/tests/runs/_template.md](./docs/tests/runs/_template.md) に沿って `docs/tests/runs/` に記録を残し、対象 `src/` ファイルと `tests/**/*.test.ts` のパスを書く
- 詳細: [tests/README.md](./tests/README.md) · [docs/tests/README.md](./docs/tests/README.md)

```bash
npm test
```

---

## 開発運用ルール

- コミットメッセージは日本語で記述する
- PR のタイトル・本文・コメントは日本語で記述する

---

## 関連リポジトリ

| リポジトリ | 参照先 |
|------------|--------|
| `event-support-frontend` | UI。接続確認は本ファイル § フロントエンドとの接続確認 |
| `event-support-recommender` | 推薦アルゴリズム。server から内部 HTTP で中継（直接呼ばないのは frontend 側） |

概要は [README.md § 関連リポジトリ](./README.md#関連リポジトリ) も参照。

---

## ドキュメント

### 追加先（新規はここ）

| ディレクトリ | 用途 |
|--------------|------|
| [docs/adrs/](./docs/adrs/) | Architecture Decision Records（設計判断の記録） |
| [docs/tests/](./docs/tests/) | テスト計画・実行記録・フィクスチャ（コードは [`tests/`](./tests/)） |
| [docs/orders/](./docs/orders/) | 作業指示・実装メモ |

**新規の ADR・テスト記録・作業メモは `docs/legacy/` ではなく、上記ディレクトリに追加する。**  
[README.md](./README.md) / 本ファイルを正とし、legacy は参照用のみ。

### AI エージェント向け

| ファイル | 用途 | 役割 |
|----------|------|------|
| [AGENTS.md](./AGENTS.md) | 詳細ガイド（正本） | 人間・全 AI |
| [README.md](./README.md) | 概要・アーキテクチャ | 人間・全 AI |
| [CLAUDE.md](./CLAUDE.md) | Claude Code 向け | 設計・要件定義（コードは書かない） |
| [.cursor/rules/](./.cursor/rules/) | Cursor Project Rules | **実装**（指示に従いコードを書く） |
| [docs/cursor/](./docs/cursor/) | テンプレート・更新用メモ | — |
| [docs/ubiquitous-language.md](./docs/ubiquitous-language.md) | ドメイン用語の正本 | 人間・全 AI |

#### Cursor（実装担当）

Cursor はユーザーの指示に従ってコードを書く。技術詳細は本ファイル（AGENTS.md）を参照すること。

| 項目 | 方針 |
|------|------|
| コマンド | 必要なものは自由に実行可。重大なバグ・ユーザー介入が必要な場合は中止して報告 |
| コミット | **日本語**、後から確認しやすい**細かい粒度**（1 意図 = 1 コミット）。明示的な依頼がない限り勝手にコミットしない |
| PR | タイトル・本文・コメントは**日本語**。作成時は「次にやること」を更新 |
| ドキュメント | 作業区切りごとに **AGENTS.md** と **docs/**（`adrs` / `tests` / `orders`）を**細かく頻繁に**更新 |

詳細: [.cursor/rules/cursor-workflow.mdc](./.cursor/rules/cursor-workflow.mdc)

- 繰り返し適用する規約は **必要に応じて** `.cursor/rules/*.mdc` を追加し、[docs/cursor/README.md](./docs/cursor/README.md) を更新

#### Claude Code（設計担当）

設計・要件定義が主務。明示的な指示がない限りコードを書かない。詳細: [CLAUDE.md](./CLAUDE.md)

- 繰り返し参照する設計方針は **必要に応じて** [CLAUDE.md](./CLAUDE.md) または `docs/adrs/` に追加
- Cursor 実装時の規約は `.cursor/rules/` への追加を提案

### レガシー（参照のみ）

モノレポ時代の設計・ADR・作業メモは `docs/legacy/` に退避済み。新規追加はしない。

- 設計: [docs/legacy/designs/](./docs/legacy/designs/)（[api.md](./docs/legacy/designs/api.md) · [database.md](./docs/legacy/designs/database.md) · [system-server.md](./docs/legacy/designs/system-server.md)）
- ADR: [docs/legacy/adrs/](./docs/legacy/adrs/)
- 作業メモ: [docs/legacy/orders/](./docs/legacy/orders/)

---

## 次にやること

**PR を作成するたびに、このセクションを更新すること。** 完了した項目は削除し、次の PR で取り組む内容を書く。

- [x] さくら上のラッパー API 設置と Cloud Run 本番接続（完了）
- [x] `routes/v1/admin/` の運営 CRUD（categories/booths/survey-questions/participants/sample-data/event-data）（完了）
- [x] WebSocket（socket.io）実装 — `checkin:new` / `rating:new` 配信（完了）
- [x] 2026-07-02 コードレビュー是正（`.sdd/2026-07-02-code-review/`）: B-1〜B-9 のバグ修正・ドキュメント同期（完了）
- [ ] `RECOMMENDER_URL` 連携の API 契約（request/response スキーマ）を `event-support-recommender` と固定化
- [ ] `ops.ts` から webhook / admin / export の責務分離
- [ ] Google Sheets エクスポート API の実装
- [ ] `GET /organizer/events` の Phase 2 実装（現状は空配列を返すスタブ）
