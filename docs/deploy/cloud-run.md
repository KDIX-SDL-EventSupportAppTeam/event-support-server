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
- **さくら DB の「データベース外部接続」が許可されていること**（必須）
- DB スキーマ適用済み（`npm run db:check` で `tables: 10` を確認）

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

# DATABASE_URL（さくら DB の接続文字列）
echo -n "mysql://USER:PASSWORD@mysqlXXXX.db.sakura.ne.jp:3306/DBNAME" \
  | gcloud secrets create DATABASE_URL --data-file=-
```

> 値を更新したい場合は `gcloud secrets versions add <NAME> --data-file=-` で新バージョンを作る。

Cloud Run のサービスアカウントに参照権限を付与:

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
SA=$PROJECT_NUMBER-compute@developer.gserviceaccount.com

for s in JWT_SECRET WEBHOOK_API_KEY DATABASE_URL; do
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

```bash
gcloud run deploy $SERVICE \
  --image=$IMAGE:latest \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --min-instances=0 \
  --max-instances=3 \
  --cpu=1 \
  --memory=512Mi \
  --set-env-vars="CORS_ORIGIN=<FRONTEND_ORIGIN>" \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,JWT_SECRET=JWT_SECRET:latest,WEBHOOK_API_KEY=WEBHOOK_API_KEY:latest"
```

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

ビルドして App Engine などに上げ直す:

```bash
cd event-support-frontend
npm run build
gcloud app deploy
```

---

## 注意点・既知の落とし穴

- **さくら DB の外部接続**: コントロールパネルで「外部接続を許可」を有効にしていないと TCP 3306 が閉じている。`nc -vz mysqlXXXX.db.sakura.ne.jp 3306` で疎通確認できる
- **Cloud Run の IP は動的**: さくら側で接続元 IP 制限をかけている場合は Cloud NAT で固定 IP を発行するか制限を外す
- **コールドスタート**: `min-instances=0` だと初回アクセスが遅い。本番中は `min-instances=1` に上げると改善
- **接続プール**: Cloud Run はインスタンスごとに DB プールを持つので、`connectionLimit` × `max-instances` がさくら DB の最大接続数を超えないこと
- **DB スキーマの適用**: Cloud Run 上では `tsx` を持たないため、`npm run db:check` / `db:migrate` / `db:seed:prod` は **ローカルから** 実行する
