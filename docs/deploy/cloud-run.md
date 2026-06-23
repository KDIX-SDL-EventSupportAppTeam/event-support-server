# Cloud Run デプロイ手順

`event-support-server` を Google Cloud Run にデプロイするための手順書。

## 前提

- GCP プロジェクトを 1 つ用意済み（例: `event-support-prod`）
- `gcloud` CLI ローカルインストール・ログイン済み
- 必要な GCP API を有効化:
  - Cloud Run API
  - Artifact Registry API
  - Secret Manager API
  - Cloud Build API
- **さくら上のラッパー API** が設置済み（`src/scripts/sakura-proxy-mock.ts` をベースに先生が HTTPS で公開）
- DB スキーマ適用済み（さくら DB 上で `db/create-tables.sql` 等を実行済み）

> さくら Standard は外部から MySQL 直接接続不可。Cloud Run は `SAKURA_PROXY_URL` 経由でラッパー API を呼ぶ（[完了メモ](../orders/2026-06-09-完了-さくらDB接続WebAPIプロキシ実装.md)）。

---

## 1. 変数定義（以後この手順で参照）

```bash
export PROJECT_ID=event-support-prod
export REGION=asia-northeast1
export SERVICE=event-support-server
export REPO=event-support           # Artifact Registry のリポジトリ名
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$SERVICE
```

```bash
gcloud config set project $PROJECT_ID
gcloud config set run/region $REGION
```

---

## 2. Artifact Registry リポジトリの作成（初回のみ）

```bash
gcloud artifacts repositories create $REPO \
  --repository-format=docker \
  --location=$REGION \
  --description="event-support container images"

gcloud auth configure-docker $REGION-docker.pkg.dev
```

---

## 3. シークレットを Secret Manager に登録

```bash
# JWT_SECRET
echo -n "$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  | gcloud secrets create JWT_SECRET --data-file=-

# WEBHOOK_API_KEY
echo -n "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" \
  | gcloud secrets create WEBHOOK_API_KEY --data-file=-

# SAKURA_PROXY_KEY（ラッパー API 認証キー。さくら側と同じ値）
echo -n "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" \
  | gcloud secrets create SAKURA_PROXY_KEY --data-file=-
```

> 値を更新したい場合は `gcloud secrets versions add <NAME> --data-file=-` で新バージョンを作る。  
> `DATABASE_URL` は Cloud Run から不要（ラッパー API がさくら内から MySQL に接続する）。

Cloud Run のサービスアカウントに参照権限を付与:

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
SA=$PROJECT_NUMBER-compute@developer.gserviceaccount.com

for s in JWT_SECRET WEBHOOK_API_KEY SAKURA_PROXY_KEY; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:$SA" \
    --role="roles/secretmanager.secretAccessor"
done
```

---

## 4. イメージのビルドとプッシュ

```bash
cd event-support-server

# Cloud Build でビルド & push（ローカル Docker 不要）
gcloud builds submit --tag $IMAGE:latest .
```

> ローカルでビルドする場合（任意・要 Apple Silicon の場合 `--platform linux/amd64`）:
> ```bash
> docker buildx build --platform linux/amd64 -t $IMAGE:latest --push .
> ```

---

## 5. Cloud Run へデプロイ

`<FRONTEND_ORIGIN>` をフロントの本番 URL に差し替える（複数ならカンマ区切り）。

> 通常は CI（`cloudbuild.yaml`）でデプロイする。下記は手動デプロイ時の参照。
> **WebSocket 関連の 4 設定は必須**（理由は [ADR 0002](../adrs/0002-cloud-run-single-instance-for-websocket.md)）。
> `gcloud run deploy` は毎回これらを上書きするため、必ず付けること。

```bash
gcloud run deploy $SERVICE \
  --image=$IMAGE:latest \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --min-instances=1 \
  --max-instances=1 \
  --session-affinity \
  --timeout=3600 \
  --cpu=1 \
  --memory=512Mi \
  --set-env-vars="CORS_ORIGIN=<FRONTEND_ORIGIN>,SAKURA_PROXY_URL=https://<sakura-host>/proxy" \
  --set-secrets="JWT_SECRET=JWT_SECRET:latest,WEBHOOK_API_KEY=WEBHOOK_API_KEY:latest,SAKURA_PROXY_KEY=SAKURA_PROXY_KEY:latest,ADMIN_REGISTRATION_KEY=ADMIN_REGISTRATION_KEY:latest"
```

| フラグ | 理由 |
|--------|------|
| `--min-instances=1` | コールドスタートによる WebSocket 接続断を防ぐ |
| `--max-instances=1` | socket.io がインメモリ管理のため複数インスタンスだと配信が届かない（[ADR 0002](../adrs/0002-cloud-run-single-instance-for-websocket.md)） |
| `--session-affinity` | 同一クライアントを同一インスタンスへルーティング |
| `--timeout=3600` | WebSocket がデフォルト 300 秒で切れるのを防ぐ |

デプロイ後の URL を控える:

```bash
gcloud run services describe $SERVICE --region=$REGION --format='value(status.url)'
# → https://event-support-server-xxxxxx-an.a.run.app
```

---

## 6. 動作確認

```bash
SERVICE_URL=$(gcloud run services describe $SERVICE --region=$REGION --format='value(status.url)')

# ヘルスチェック
curl -s $SERVICE_URL/health
# → {"ok":true}

# ルート（案内 JSON）
curl -s $SERVICE_URL/
# → {"service":"event-support-server", ...}
```

ログ確認:

```bash
gcloud run logs read $SERVICE --region=$REGION --limit=50
```

---

## 7. フロント側の差し替え

`event-support-frontend/.env.production`:

```
VITE_API_BASE_URL=https://event-support-server-xxxxxx-an.a.run.app/api/v1
VITE_DATA_SOURCE=api
VITE_MOCK_API=false
```

フロントは Firebase Hosting にデプロイする（`event-support-frontend/cloudbuild.yaml` 参照）:

```bash
cd event-support-frontend
npm run build
firebase deploy --only hosting --project event-support-app
```

---

## 注意点・既知の落とし穴

- **さくら Standard の MySQL**: Cloud Run から 3306 直接接続は不可。ラッパー API（HTTPS）経由のみ
- **ラッパー API はエラーを 500 に潰す**: MySQL のエラーコードが取れないため、一意制約は INSERT 前に SELECT で確認する（[ADR 0001](../adrs/0001-sakura-proxy-error-masking.md)）
- **WebSocket は 1 インスタンス固定が前提**: `--max-instances=1` 等が無いとリアルタイム配信が届かない（[ADR 0002](../adrs/0002-cloud-run-single-instance-for-websocket.md)）
- **ラッパー API の HTTPS**: 本番は必ず HTTPS。ローカルモック（`npm run proxy:mock`）は HTTP の開発専用
- **DB スキーマの適用**: さくら DB 上で `db/create-tables.sql` を実行。`db:check` / `db:seed:prod` は **ローカルまたはさくら内** から実行
