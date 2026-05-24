# event-support-server — Fastify REST API

概要・ディレクトリ構造・起動手順・関連リポジトリは [README.md](./README.md) を参照。

---

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `DATABASE_URL` | ✅ | `mysql://user:pass@host:3306/dbname` |
| `JWT_SECRET` | ✅ | JWT 署名キー（本番は 32 文字以上のランダム文字列） |
| `WEBHOOK_API_KEY` | 本番 ✅ | Google Apps Script から受け取る Webhook 認証キー（開発は空でも可） |
| `RECOMMENDER_URL` | — | 推薦エンジンの URL（未設定時は内部ランダム推薦にフォールバック）※ |
| `CORS_ORIGIN` | — | 許可するオリジン（カンマ区切り。未設定時は `http://localhost:5173`） |
| `PORT` | — | リッスンポート（既定: `3000`） |

※ `RECOMMENDER_URL` は設計上の予定。現行 `config.ts` 未対応の場合は `recommendations.ts` のスタブ実装を正とする。

---

## 実装済みエンドポイント

| メソッド | パス | 認証 | 説明 |
|----------|------|------|------|
| GET | `/health` | — | 死活監視 |
| POST | `/api/v1/auth/register` | — | 参加者登録 |
| POST | `/api/v1/auth/login` | — | ログイン・JWT 発行 |
| GET | `/api/v1/events/:event_id/survey/questions` | Bearer | アンケート設問取得 |
| POST | `/api/v1/events/:event_id/survey/answers` | Bearer | アンケート回答送信 |
| GET | `/api/v1/events/:event_id/booths` | Bearer | ブース一覧（カテゴリフィルタ可） |
| GET | `/api/v1/events/:event_id/booths/:booth_id` | Bearer | ブース詳細 |
| POST | `/api/v1/events/:event_id/checkins` | Bearer | チェックイン（QR / 手動コード） |
| GET | `/api/v1/events/:event_id/checkins` | Bearer | 自分のチェックイン履歴 |
| POST | `/api/v1/events/:event_id/checkins/:checkin_id/rating` | Bearer | 評価送信 |
| GET | `/api/v1/events/:event_id/recommendations` | Bearer | 推薦取得（現在はランダム） |
| POST | `/api/v1/events/:event_id/recommendations/:recommendation_id/select` | Bearer | 推薦選択 |
| POST | `/api/v1/webhook/booths/sync` | `X-Api-Key` | ブース情報同期（Google Forms） |
| GET | `/api/v1/admin/events/:event_id/dashboard` | Bearer（`role: admin`） | 運営ダッシュボード（簡易集計） |

未実装（設計済み）: WebSocket・運営 CRUD の大部分（dashboard 以外）→ Issue #8  
詳細は [docs/legacy/designs/api.md](./docs/legacy/designs/api.md) を参照。

---

## 認証の仕組み

```
POST /api/v1/auth/login → JWT 発行（payload: { sub, event_id, display_name, role }）
        ↓
以降のリクエストに Authorization: Bearer <token> を付与
        ↓
requireBearerAuth         → トークンの署名・有効期限を検証
requireEventMatchesJwt    → URL の :event_id と JWT の event_id が一致するか検証
```

運営向けエンドポイントは JWT の `role: admin` を検証する（`requireAdminRole` への共通化は Issue #8 予定）。  
ペイロードの詳細は [docs/ubiquitous-language.md](./docs/ubiquitous-language.md) § 認証・ユーザーを参照。

---

## DB

スキーマの正は `db/migrations/01_initial_schema.sql`（10 テーブル）。  
起動手順・Docker init と `db:migrate` の使い分けは [README.md § ローカル開発](./README.md#ローカル開発) を参照。  
設計の解説は [docs/legacy/designs/database.md](./docs/legacy/designs/database.md) を参照。

```bash
# テーブル数確認
docker exec -it event-support-mysql \
  mysql -u app -pappsecret event_support \
  -NBe "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='event_support';"
# 10 が返ること
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

開発用シードの定数は `src/scripts/seed-dev.ts` 先頭を参照。

---

## テスト

```bash
npm test
```

---

## 参照

| 種別 | パス |
|------|------|
| 概要・起動手順 | [README.md](./README.md) |
| 設計・要件定義 | [CLAUDE.md](./CLAUDE.md) · [docs/cursor/README.md](./docs/cursor/README.md) |
| ドメイン用語 | [docs/ubiquitous-language.md](./docs/ubiquitous-language.md) |
| API 設計 | [docs/legacy/designs/api.md](./docs/legacy/designs/api.md) |
| DB 設計 | [docs/legacy/designs/database.md](./docs/legacy/designs/database.md) |
| システム設計 | [docs/legacy/designs/system-server.md](./docs/legacy/designs/system-server.md) |
| ADR | [docs/legacy/adrs/](./docs/legacy/adrs/) |
