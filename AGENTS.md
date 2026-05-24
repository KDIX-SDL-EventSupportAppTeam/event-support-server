# event-support-server — Fastify REST API

**スタック:** Node.js 20+ / TypeScript / Fastify 5 / MySQL 8（mysql2）

認証・認可（JWT Bearer）・バリデーション（zod）・DB アクセスはこのリポジトリで完結する。  
アーキテクチャ概要・他サービスとの関係・関連リポジトリは [README.md](./README.md) を参照。

---

## ディレクトリ構成

```
src/
├── routes/v1/
│   ├── auth.ts              # 登録・ログイン
│   ├── booths.ts            # ブース一覧・詳細
│   ├── checkins.ts          # チェックイン・評価
│   ├── recommendations.ts   # 推薦取得・選択
│   ├── survey.ts            # アンケート設問・回答
│   ├── ops.ts               # Webhook・エクスポート（運営 dashboard 暫定同居）
│   └── admin/               # 運営 CRUD（Issue #8）
├── db/
│   ├── pool.ts              # MySQL コネクションプール
│   └── parse-mysql-url.ts   # DATABASE_URL パーサー
├── lib/
│   ├── datetime.ts          # ISO8601 ↔ MySQL UTC 変換
│   ├── jwt.ts               # JWT 署名・検証
│   └── response.ts          # sendOk / sendFail ヘルパー
├── plugins/
│   └── auth.ts              # requireBearerAuth / requireEventMatchesJwt
├── scripts/
│   ├── db-migrate.ts        # CREATE TABLE 実行（npm run db:migrate）
│   └── seed-dev.ts          # 開発用データ投入（npm run db:seed）
├── types/
│   └── fastify.d.ts         # app.db / app.config / req.jwtUser の型拡張
├── app.ts                   # Fastify インスタンス生成・ルート登録
├── config.ts                # 環境変数ロード・バリデーション
└── index.ts                 # サーバー起動エントリーポイント

db/
├── migrations/
│   └── 01_initial_schema.sql  # テーブル定義の正（10 テーブル）
└── create-tables.sql          # さくら等への引き渡し用 DDL
```

---

## 開発

起動手順・前提条件は [README.md § ローカル開発](./README.md#ローカル開発) を参照。  
以下はエージェント向けの補足。

```bash
cp .env.example .env   # DATABASE_URL / JWT_SECRET / WEBHOOK_API_KEY を設定
npm install
docker compose up -d mysql
npm run db:migrate     # 初回のみ
npm run db:seed        # 初回のみ
npm run dev            # http://localhost:3000
```

動作確認:

```bash
curl http://localhost:3000/health
# {"ok":true}

curl -s http://localhost:3000/
# {"service":"event-support-server","health":"/health","api":"/api/v1"}
```

### 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `DATABASE_URL` | ✅ | `mysql://user:pass@host:3306/dbname` |
| `JWT_SECRET` | ✅ | JWT 署名キー（本番は 32 文字以上のランダム文字列） |
| `WEBHOOK_API_KEY` | ✅ | Google Apps Script から受け取る Webhook 認証キー |
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

未実装（設計済み）: WebSocket・運営 CRUD の大部分 → Issue #8  
詳細は [docs/legacy/designs/api.md](./docs/legacy/designs/api.md) を参照。

---

## 認証の仕組み

```
POST /auth/login → JWT 発行（payload: { sub: user_id, event_id, role }）
        ↓
以降のリクエストに Authorization: Bearer <token> を付与
        ↓
requireBearerAuth         → トークンの署名・有効期限を検証
requireEventMatchesJwt    → URL の :event_id と JWT の event_id が一致するか検証
```

`role: admin` のみアクセスできるエンドポイントは `requireAdminRole`（Issue #8 で追加予定）。

---

## DB

スキーマの正は `db/migrations/01_initial_schema.sql`（10 テーブル）。  
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
# 1. MySQL・サーバー起動
docker compose up -d mysql
npm run dev

# 2. フロントエンド側（event-support-frontend）で
#    VITE_MOCK_API=false / VITE_DATA_SOURCE=api を設定して npm run dev

# 3. dev@example.com / password123 でログイン（db:seed 済みの場合）
#    または /register で新規登録
```

開発用シードの定数は `src/scripts/seed-dev.ts` 先頭を参照（`dev@example.com` / `password123`）。

---

## テスト

```bash
npm test
```

---

## 参照

| 種別 | パス |
|------|------|
| 概要・アーキテクチャ | [README.md](./README.md) |
| API 設計 | [docs/legacy/designs/api.md](./docs/legacy/designs/api.md) |
| DB 設計 | [docs/legacy/designs/database.md](./docs/legacy/designs/database.md) |
| システム設計 | [docs/legacy/designs/system-server.md](./docs/legacy/designs/system-server.md) |
| ADR | [docs/legacy/adrs/](./docs/legacy/adrs/) |
| フロントエンド | `event-support-frontend` |
| 推薦エンジン | `event-support-recommender` |
