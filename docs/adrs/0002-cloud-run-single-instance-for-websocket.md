# 0002. WebSocket 配信のため Cloud Run を 1 インスタンスに固定する

- 日付: 2026-06-24
- ステータス: 承認

## コンテキスト

運営画面のリアルタイム更新は socket.io（`src/plugins/socket.ts`）で行う。
チェックイン/評価のたびに `app.io.to('event:<id>:admin').emit(...)` で配信する。

socket.io はルーム/接続を**各インスタンスのメモリ内**で管理しており、共有 adapter
（Redis 等）を入れていない。Cloud Run は既定で複数インスタンス（maxScale=3）まで
スケールするため、本番でアクセスが増えると:

- 参加者のチェックイン POST を処理するインスタンス
- 運営画面の WebSocket が繋がっているインスタンス

が別々になり、`emit` が他インスタンスの socket に届かない。データは DB 共有なので
**「リロードすれば見えるがリアルタイムでは来ない」**という症状になる。

加えて、WebSocket 接続維持には session affinity と長いタイムアウトも必要。

## 決定

Cloud Run を **1 インスタンスに固定**し、WebSocket 用の設定を `cloudbuild.yaml` に明記する:

```
--min-instances=1      # コールドスタートによる接続断を防ぐ
--max-instances=1      # 全 socket と全リクエストを同一インスタンスに集約
--session-affinity     # 同一クライアントを同一インスタンスへ
--timeout=3600         # WebSocket がデフォルト 300 秒で切れるのを防ぐ
```

運営画面のみが socket を張り（参加者は張らない）、負荷も軽いため 1 台で十分。

## 結果・トレードオフ

- インスタンス跨ぎが起きず、リアルタイム配信が確実に動く。
- **水平スケールしない。** 想定来場規模（数百人・運営 socket は数本）では問題ないが、
  将来大規模化する場合は本決定を見直し、**socket.io の Redis adapter（Memorystore 等）**
  を導入して maxScale を上げる。
- `gcloud run deploy` は毎回これらの設定を上書きするため、`cloudbuild.yaml` に
  書いておくこと（手動 `gcloud run services update` だけだと次回デプロイで失われる）。

## 関連

- [socket.ts](../../src/plugins/socket.ts) — ルーム参加（`event:<id>` / `event:<id>:admin`）
- [Cloud Run デプロイ手順](../deploy/cloud-run.md)
