# テスト実行記録 — 2026-06-09（さくらDBプロキシ手動検証）

## 何を

### 対象（src）

- `src/db/client.ts`
- `src/db/http-proxy.ts`
- `src/db/pool.ts`
- `src/config.ts`
- `src/index.ts`
- `src/app.ts`
- `src/lib/jwt.ts`
- `src/types/fastify.d.ts`
- `src/scripts/sakura-proxy-mock.ts`

### テストコード（tests）

- なし（手動検証のみ）

## なぜ

[docs/orders/2026-06-09-完了-さくらDB接続WebAPIプロキシ実装.md](../../orders/2026-06-09-完了-さくらDB接続WebAPIプロキシ実装.md) の完了条件確認。

## 実行コマンド

```bash
npm run build
docker compose up -d mysql
npm run db:seed
npm run proxy:mock          # ターミナル A
SAKURA_PROXY_URL=http://localhost:3001 npm run dev   # ターミナル B

curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"event_id":"20000000-0000-4000-8000-000000000001","email":"dev@example.com","password":"password123"}'
```

## 環境

- ブランチ: `feature/sakura-db-proxy`
- MySQL: Docker 起動済み（`event_support`、シード投入済み）
- 関連 PR / Issue: なし

## 結果

- `npm run build` — 成功
- `npm run proxy:mock` — `http://localhost:3001` で起動
- プロキシ経由ログイン — 成功（JWT 取得）
- `/health` — `{"ok":true,...}`
- `src/routes/v1/` — 変更なし

## メモ

- 本番さくら上のラッパー API 設置と Cloud Run 環境変数設定は未実施（先生担当）
- フロント接続時は `VITE_API_BASE_URL=http://localhost:3000/api/v1` が必要（`/api/v1` プレフィックス）
