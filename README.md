# event-support-server

イベント支援アプリのバックエンド API。Fastify + TypeScript + MySQL で `/api/v1` 配下の REST を提供する。

## アーキテクチャ

### このリポジトリの責任

フロントエンドへの REST API・WebSocket 提供と、データベース操作・推薦エンジンへの中継を担うハブサービス。

**担当すること**

- REST API（`/api/v1`）の提供
- JWT による認証・認可
- MySQL へのデータ読み書き
- 推薦エンジンへのリクエスト中継と結果返却
- WebSocket によるリアルタイム通知（Issue #8）
- Google Forms Webhook の受信とブース情報の同期
- Google Sheets へのデータエクスポート（イベント終了時）
- DB スキーマ・マイグレーション管理

**担当しないこと**

- 推薦アルゴリズムの実装（`event-support-recommender` に委譲）
- フロントエンドの描画ロジック・ビルド

### 他サービスとの関係

```
[event-support-frontend]
        │ HTTPS REST / WebSocket
        ▼
[event-support-server]  ←── Google Forms（Webhook）
        │                        │
        │ 内部 HTTP                │ SQL
        ▼                        ▼
[event-support-recommender]   [MySQL（Cloud SQL）]
```

## ディレクトリ構造

```
src/
├── routes/v1/
│   ├── auth.ts              # 登録・ログイン
│   ├── booths.ts            # ブース一覧・詳細
│   ├── checkins.ts          # チェックイン・評価
│   ├── recommendations.ts   # 推薦取得・選択
│   ├── survey.ts            # アンケート設問・回答
│   ├── ops.ts               # Webhook・エクスポート
│   └── admin/               # 運営 CRUD（Issue #8）
├── db/
│   ├── pool.ts
│   └── parse-mysql-url.ts
├── lib/
│   ├── datetime.ts
│   ├── jwt.ts
│   └── response.ts
├── plugins/
│   └── auth.ts
├── scripts/
│   ├── db-migrate.ts        # CREATE TABLE 実行
│   └── seed-dev.ts          # 開発用データ投入
├── types/
│   └── fastify.d.ts
├── app.ts
├── config.ts
└── index.ts

db/
├── migrations/
│   └── 01_initial_schema.sql
└── create-tables.sql
```

> **Note:** 現時点では運営向けエンドポイントの一部は `ops.ts` に同居している。Issue #8 で `routes/v1/admin/` へ分離予定。

## ローカル開発

```bash
cp .env.example .env      # DATABASE_URL・JWT_SECRET・WEBHOOK_API_KEY を設定
npm install
docker compose up -d mysql
npm run db:migrate        # 初回のみ（空 DB にテーブル作成）
npm run db:seed           # 初回のみ（開発用データ投入）
npm run dev               # http://localhost:3000
```

動作確認:

```bash
curl http://localhost:3000/health
# {"ok":true}
```

## 関連リポジトリ

| リポジトリ | 役割 |
|------------|------|
| `event-support-frontend` | UI（API の呼び出し元） |
| `event-support-recommender` | 推薦エンジン（内部 HTTP で呼び出す） |

## 参照

- [AGENTS.md](./AGENTS.md) — エージェント向け開発メモ（環境変数・エンドポイント・認証）
- [docs/legacy/designs/](./docs/legacy/designs/) — API・DB 設計（リファクタリング前の詳細仕様）
