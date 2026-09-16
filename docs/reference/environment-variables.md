---
状態: 実装済み
最終更新: 2026-09-16
---

> **現状の事実を記録する文書。** 「これからどうするか」は [../specs/](../specs/README.md) を見ること。

# 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `DATABASE_URL` | △ | TCP: `mysql://user:pass@host:3306/dbname`。Unix ソケット: `mysql://user:pass@localhost/dbname?socket=/cloudsql/<接続名>`（本番 Cloud Run → Cloud SQL）。`SAKURA_PROXY_URL` 未設定時は必須 |
| `SAKURA_PROXY_URL` | △ | **旧本番（切り戻し用）。** さくら上ラッパー API のベース URL。**設定されていると `DATABASE_URL` より優先される** |
| `SAKURA_PROXY_KEY` | プロキシ使用時 ✅ | ラッパー API 認証キー（`X-Proxy-Key` ヘッダー） |
| `JWT_SECRET` | ✅ | JWT 署名キー（本番は 32 文字以上のランダム文字列） |
| `WEBHOOK_API_KEY` | 本番 ✅ | Google Apps Script から受け取る Webhook 認証キー（開発は空でも可） |
| `ADMIN_REGISTRATION_KEY` | ✅ | 運営アカウント登録（`POST /auth/register/admin`）の `X-Admin-Key` 検証キー。開発でも必須 |
| `FRONTEND_BASE_URL` | — | イベント作成時に発行する参加者/運営 URL と確認メール中の URL のベース。未設定時は `CORS_ORIGIN` の先頭オリジンを使用する（本番で未設定なら起動時に警告） |
| `ORGANIZER_REGISTRATION_KEY` | invite 時 ✅ | オーガナイザー登録（`POST /organizer/auth/register`）の `X-Organizer-Key` 検証キー |
| `ORGANIZER_SIGNUP_MODE` | — | `invite`（既定・キー必須）\| `open`（誰でも登録可）\| `disabled`（登録停止・410、本番推奨） |
| `RECOMMENDER_URL` | — | 推薦エンジン（`event-support-recommend`）のベース URL。**未設定・空文字なら呼び出さず即フォールバック**（訪問者数の少ない順。人気順にはしない） |
| `RECOMMENDER_TIMEOUT_MS` | — | 推薦呼び出しのタイムアウト（既定 `1000`）。超えたらフォールバックへ |
| `RECOMMENDER_OPS_TOKEN` | — | 推薦エンジンの `/ops/state` 中継に使う共有シークレット。推薦側の `OPS_TOKEN`・分析側の `RECOMMEND_OPS_TOKEN` と**同一の値**。`X-Ops-Token` ヘッダーで送る（`Authorization` は使わない）。応答にもログにも値を出さない |
| `RECOMMENDER_STATE_TIMEOUT_MS` | — | `/ops/state` 中継のタイムアウト（既定 `2000`）。解放経路の `RECOMMENDER_TIMEOUT_MS` とは別物。到達不能時は 200 で `available:false` を返す |
| `RATING_SCALE` | — | 評価の段階数（既定 `4`）。`booth_ratings.scale` に保存し、API が参加者へ配信する |
| `CHECKIN_COOLDOWN_SEC` | — | 同一ユーザーの連続チェックインを拒否する最短間隔（既定 `0` = 無効） |
| `CORS_ORIGIN` | — | 許可するオリジン（カンマ区切り。未設定時は `http://localhost:5173`） |
| `PORT` | — | リッスンポート（既定: `3000`。Cloud Run では `$PORT` が自動注入される） |
| `SMTP_HOST` | — | 確認メール送信用 SMTP ホスト。未設定時はログ出力モード（実送信せず確認URLをサーバログに出す）。**`NODE_ENV=production` では必須**で、未設定なら起動時にエラーで停止する |
| `SMTP_PORT` | — | SMTP ポート（既定: `587`。`465` のみ暗黙TLS、それ以外は STARTTLS） |
| `SMTP_USER` | — | SMTP 認証ユーザー |
| `SMTP_PASS` | — | SMTP 認証パスワード |
| `MAIL_FROM` | — | 確認メールの送信元の**既定値**（既定: `PRoToFES <no-reply@example.com>`）。イベントに `events.mail_from` があればそちらを From / Reply-To に使う |

> `DATABASE_URL` と `SAKURA_PROXY_URL` の**どちらか一方**は必須。両方あると `SAKURA_PROXY_URL` が勝つ（`src/index.ts`）。本番は Cloud SQL なので `DATABASE_URL` のみを渡し、`SAKURA_PROXY_URL` は**残さない**（[ADR 0008](../decisions/adrs/0008-move-production-db-to-cloud-sql.md)）。

### 本番（Cloud Run）向けの渡し方

- `JWT_SECRET` / `WEBHOOK_API_KEY` / `DATABASE_URL` / `ADMIN_REGISTRATION_KEY` / `SMTP_PASS` は **Secret Manager** に登録し、Cloud Run の `--set-secrets` で渡す
- `CORS_ORIGIN` / `RECOMMENDER_URL` / `FRONTEND_BASE_URL` / `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `MAIL_FROM` は `--set-env-vars` で渡す。**`--update-env-vars` は使わない**（既存サービスに残った `SAKURA_PROXY_URL` が消えず、プロキシ経路のまま動く）
- `DATABASE_URL` は Cloud Run 用（`?socket=/cloudsql/...`）とローカルから `cloud-sql-proxy` 経由で触る用（`127.0.0.1:3307`）で**別の文字列**になる
- 値はリポジトリにコミットしない（`.env` は `.gitignore` 済み）
- 詳細手順: [docs/operations/cloud-run.md](../operations/cloud-run.md)

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
