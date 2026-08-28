---
状態: 実装済み
最終更新: 2026-08-24
---

> **現状の事実を記録する文書。** 「これからどうするか」は [../specs/](../specs/README.md) を見ること。

# 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `DATABASE_URL` | △ | `mysql://user:pass@host:3306/dbname`。`SAKURA_PROXY_URL` 未設定時は必須 |
| `SAKURA_PROXY_URL` | △ | さくら上ラッパー API のベース URL（例: `https://example.sakura.ne.jp/proxy`）。設定時は HTTP プロキシ経由で DB アクセス |
| `SAKURA_PROXY_KEY` | プロキシ使用時 ✅ | ラッパー API 認証キー（`X-Proxy-Key` ヘッダー。本番は Secret Manager） |
| `JWT_SECRET` | ✅ | JWT 署名キー（本番は 32 文字以上のランダム文字列） |
| `WEBHOOK_API_KEY` | 本番 ✅ | Google Apps Script から受け取る Webhook 認証キー（開発は空でも可） |
| `ADMIN_REGISTRATION_KEY` | ✅ | 運営アカウント登録（`POST /auth/register/admin`）の `X-Admin-Key` 検証キー。開発でも必須 |
| `FRONTEND_BASE_URL` | — | イベント作成時に発行する参加者/運営 URL と確認メール中の URL のベース。未設定時は `CORS_ORIGIN` の先頭オリジンを使用する（本番で未設定なら起動時に警告） |
| `ORGANIZER_REGISTRATION_KEY` | invite 時 ✅ | オーガナイザー登録（`POST /organizer/auth/register`）の `X-Organizer-Key` 検証キー |
| `ORGANIZER_SIGNUP_MODE` | — | `invite`（既定・キー必須）\| `open`（誰でも登録可）\| `disabled`（登録停止・410、本番推奨） |
| `RECOMMENDER_URL` | — | 推薦エンジン（`event-support-recommend`）のベース URL。**未設定・空文字なら呼び出さず即フォールバック**（訪問者数の少ない順。人気順にはしない） |
| `RECOMMENDER_TIMEOUT_MS` | — | 推薦呼び出しのタイムアウト（既定 `1000`）。超えたらフォールバックへ |
| `RATING_SCALE` | — | 評価の段階数（既定 `4`）。`booth_ratings.scale` に保存し、API が参加者へ配信する |
| `CHECKIN_COOLDOWN_SEC` | — | 同一ユーザーの連続チェックインを拒否する最短間隔（既定 `0` = 無効） |
| `CORS_ORIGIN` | — | 許可するオリジン（カンマ区切り。未設定時は `http://localhost:5173`） |
| `PORT` | — | リッスンポート（既定: `3000`。Cloud Run では `$PORT` が自動注入される） |
| `SMTP_HOST` | — | 確認メール送信用 SMTP ホスト。未設定時はログ出力モード（実送信せず確認URLをサーバログに出す）。**`NODE_ENV=production` では必須**で、未設定なら起動時にエラーで停止する |
| `SMTP_PORT` | — | SMTP ポート（既定: `587`。`465` のみ暗黙TLS、それ以外は STARTTLS） |
| `SMTP_USER` | — | SMTP 認証ユーザー |
| `SMTP_PASS` | — | SMTP 認証パスワード |
| `MAIL_FROM` | — | 確認メールの送信元（既定: `PRoToFES <no-reply@example.com>`） |

> `DATABASE_URL` と `SAKURA_PROXY_URL` の**どちらか一方**は必須。本番（さくら Standard）は外部から MySQL 直接接続不可のため、通常は `SAKURA_PROXY_URL` + `SAKURA_PROXY_KEY` を使う。

### 本番（Cloud Run）向けの渡し方

- `JWT_SECRET` / `WEBHOOK_API_KEY` / `SAKURA_PROXY_KEY` / `ADMIN_REGISTRATION_KEY` は **Secret Manager** に登録し、Cloud Run の `--set-secrets` で渡す
- `SAKURA_PROXY_URL` / `PORT` / `CORS_ORIGIN` / `RECOMMENDER_URL` は `--set-env-vars` で渡す
- 本番（さくら Standard）では `SAKURA_PROXY_URL` 経由が前提。`DATABASE_URL` は Cloud Run から不要（ラッパー API がさくら内から MySQL に接続）
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
