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

開発用シードの定数は [docs/tests/fixtures/dummy-login.md](./docs/tests/fixtures/dummy-login.md)（`src/scripts/seed-dev.ts` と同期）。

---

## テスト

| 場所 | 役割 |
|------|------|
| [`tests/`](./tests/) | Vitest のテストコード（`unit/`・`integration/`）。**ここにまとめる** |
| [`docs/tests/`](./docs/tests/) | 実行記録（`runs/`）・フィクスチャ（`fixtures/`） |

- `src/` 内に `*.test.ts` を置かない（移行中の `src/lib/datetime.test.ts` は [tests/README.md](./tests/README.md) 参照）
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

- [ ] `tests/` へ Vitest を移行（`src/lib/datetime.test.ts` を `tests/unit/` へ移す）
- [ ] `routes/v1/admin/` への運営 CRUD 分離（Issue #8。dashboard は現状 `ops.ts` に同居）
- [ ] `RECOMMENDER_URL` を `config.ts` に追加し `event-support-recommender` へ中継
- [ ] WebSocket（socket.io）実装（Issue #8）
- [ ] `ops.ts` から webhook / admin / export の責務分離
- [ ] Google Sheets エクスポート API の実装
