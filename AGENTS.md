# server/ — Fastify API（設計 `docs/designs/api.md`）

## スタック

- Node.js 20+ / TypeScript / Fastify 5
- MySQL 8（`mysql2`）。スキーマはリポジトリ直下 `db/migrations/` と `docs/designs/database.md` §11

## 起動

```bash
cp .env.example .env   # DATABASE_URL / JWT_SECRET / WEBHOOK_API_KEY を編集
npm install
npm run dev             # http://0.0.0.0:3000 （/api/v1 配下）
```

前提: MySQL が起動していること（ローカルは `docker compose up -d mysql`）。空 DB には `npm run db:migrate` で `db/migrations/01_initial_schema.sql` の CREATE を流す（Docker 初回 init 済みなら不要）。開発データは `npm run db:seed`。

ブラウザで **`http://127.0.0.1:3000/`** を開くと、API プレフィックス（`/api/v1`）と `/health` の案内 JSON が返ります。

## エンドポイント（抜粋）

| メソッド | パス | 備考 |
|----------|------|------|
| POST | `/api/v1/auth/login` | 設計 §15 |
| POST | `/api/v1/auth/register` | 同上 |
| GET | `/api/v1/events/:event_id/survey/questions` | Bearer 必須 |
| POST | `/api/v1/events/:event_id/survey/answers` | 同上 |
| GET | `/api/v1/events/:event_id/booths` | 同上 |
| GET | `/api/v1/events/:event_id/booths/:booth_id` | 同上 |
| POST | `/api/v1/events/:event_id/checkins` | QR / manual |
| GET | `/api/v1/events/:event_id/checkins` | 同上 |
| POST | `/api/v1/events/:event_id/checkins/:checkin_id/rating` | 同上 |
| GET | `/api/v1/events/:event_id/recommendations` | 同上（簡易スタブ） |
| POST | `/api/v1/events/:event_id/recommendations/:recommendation_id/select` | 同上 |
| GET | `/api/v1/admin/events/:event_id/dashboard` | JWT `role: admin` |
| POST | `/api/v1/webhook/booths/sync` | `X-Api-Key` |

未実装・設計のみ: WebSocket、多数の `/admin/*` CRUD。詳細は [api.md](../docs/designs/api.md) 冒頭の実装メモ。

## テスト

```bash
npm test
```

## 参照

- [docs/designs/api.md](../docs/designs/api.md)
- ルート [README.md](../README.md)（MySQL・シード手順）
