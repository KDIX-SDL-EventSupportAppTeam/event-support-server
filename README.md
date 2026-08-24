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
- WebSocket によるリアルタイム通知
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
[event-support-recommender]   [MySQL（さくら / Docker）]
                              ↑ 本番はさくら上ラッパー API 経由（HTTPS）
```

## ディレクトリ構造

```
src/
├── routes/v1/
│   ├── auth.ts              # 参加者/運営登録・ログイン
│   ├── booths.ts            # ブース一覧・詳細
│   ├── checkins.ts          # チェックイン・評価
│   ├── recommendations.ts   # 推薦取得・選択
│   ├── survey.ts            # アンケート設問・回答
│   ├── ops.ts               # Webhook・エクスポート
│   ├── admin/               # 運営 CRUD（dashboard・analytics・categories・
│   │                         #   admin-booths・survey-questions・participants・
│   │                         #   sample-data・event-data・audit-logs・events）
│   └── organizer/            # オーガナイザー（auth・events・staff）
├── db/
│   ├── client.ts          # DbClient / DbConnection インターフェース
│   ├── pool.ts            # mysql2 直接接続
│   ├── http-proxy.ts      # さくらラッパー API 経由
│   └── parse-mysql-url.ts
├── lib/
│   ├── datetime.ts
│   ├── jwt.ts
│   ├── response.ts
│   ├── audit.ts            # 監査ログ記録ヘルパー
│   ├── url.ts              # 参加者/運営 URL 生成
│   ├── json-array.ts
│   ├── safe-compare.ts     # API キーのタイミングセーフ比較
│   ├── event-data/          # イベントデータ全削除
│   └── sample-data/         # サンプルデータ生成・削除
├── plugins/
│   ├── auth.ts
│   └── socket.ts
├── scripts/
│   ├── db-migrate.ts        # 空 DB への CREATE TABLE 実行（db/create-tables.sql）
│   ├── db-check.ts          # DB 接続・テーブル数確認
│   ├── seed-dev.ts          # 開発用データ投入
│   ├── seed-prod.ts         # 本番向け初期データ投入
│   ├── seed-sample.ts       # サンプルデータ投入
│   ├── clear-sample.ts      # サンプルデータ削除
│   ├── clear-event.ts       # イベントデータ全削除
│   └── sakura-proxy-mock.ts # さくらラッパー API のローカルモック
├── types/
│   └── fastify.d.ts
├── app.ts
├── config.ts
└── index.ts

db/
├── migrations/
│   ├── 01_initial_schema.sql
│   ├── 02_add_user_role.sql
│   ├── 03_organizer_self_management.sql
│   ├── 04_booth_categories.sql
│   ├── 05_exhibitor_booths.sql
│   ├── 06_booth_rating_comments.sql
│   ├── 07_email_verification.sql
│   ├── 08_event_survey_url.sql
│   └── 09_bingo_staged_unlock.sql
└── create-tables.sql          # 空 DB への `npm run db:migrate` はこちらを使う（18 テーブル）
```

## ローカル開発

```bash
cp .env.example .env      # DATABASE_URL・JWT_SECRET・WEBHOOK_API_KEY を設定
npm install
docker compose up -d mysql
npm run db:seed           # 初回のみ（開発用データ投入）
npm run dev               # http://localhost:3000
```

さくら DB プロキシのローカル検証（任意）:

```bash
npm run proxy:mock        # ターミナル A: http://localhost:3001
SAKURA_PROXY_URL=http://localhost:3001 npm run dev   # ターミナル B
```

詳細: [docs/orders/2026-06-09-完了-さくらDB接続WebAPIプロキシ実装.md](./docs/archive/orders/2026-06-09-完了-さくらDB接続WebAPIプロキシ実装.md)

> **DB スキーマ:** `docker compose up` 初回（空ボリューム）では `db/migrations/` が MySQL init で自動適用される。  
> `npm run db:migrate` は **Docker 未使用時**、または **init 前の空 DB** 向け。Docker 初回 init 済みなら不要（実行すると「既にテーブルあり」で終了する）。

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

| 種別 | パス |
|------|------|
| 技術詳細 | [AGENTS.md](./AGENTS.md) — 環境変数・エンドポイント・認証・DB・テスト・ドキュメント運用 |
| ドキュメント全体 | [docs/README.md](./docs/README.md) |
| 規約（Git・実装・テスト） | [docs/rules/](./docs/rules/README.md) |
| ドメイン用語 | [docs/ubiquitous-language.md](./docs/ubiquitous-language.md) |
| テスト | [tests/README.md](./tests/README.md) · [docs/tests/README.md](./docs/tests/README.md) |
| 詳細設計（移行元・参照のみ） | [docs/archive/legacy/designs/](./docs/archive/legacy/designs/) |
