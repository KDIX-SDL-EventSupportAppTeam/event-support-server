# 0007. 待ち受けは `0.0.0.0` のまま維持し、開発時の接続先は `127.0.0.1` と明記する

- 日付: 2026-09-05
- ステータス: 承認

## コンテキスト

`src/index.ts` は `host: '0.0.0.0'`（IPv4 のみ）で待ち受けている。開発環境で `localhost` を
使うと、Windows が先に IPv6（`::1`）へ接続を試みて失敗し、IPv4 へフォールバックする分だけ
毎リクエスト約 200ms 遅くなる（実測: `localhost:3000` 219ms / `127.0.0.1:3000` 5.7ms。
`docs/tests/runs/2026-08-25-bingo-dynamic-unlock.md`）。

回避策として frontend の `.env.example` は `127.0.0.1` を例示しているが、server 側の README は
`localhost` のままで、理由がどこにも書かれていなかった。本番投入前に「デュアルスタック
（`::`）にするか」を決める必要があった（`docs/specs/bingo-dynamic-unlock/00-must-do.md`）。

## 決定

- 待ち受けは **`0.0.0.0` のまま変更しない**。
- 開発時の接続先は **`127.0.0.1`** とし、README の「ローカル開発」節にその理由を明記する。
- `::`（デュアルスタック）への変更は **イベント（2026-10-16）終了後に再検討**する。
  切り替える条件: Cloud Run 上で `::` 待ち受けの `/health` と socket.io 接続を実機で確認し、
  既存の単体・結合テスト（`app.inject` を含む）が通ること。

## 結果・トレードオフ

- 本番（Cloud Run）へ影響する変更をイベント直前に入れない。
- 本番の到達性は変わらない: Cloud Run はコンテナの `$PORT` へ HTTP を届け、現在の
  `0.0.0.0` で稼働している。外向きの IPv4/IPv6 は Google 側で終端されるため
  コンテナ側の待ち受けアドレスは到達性に関係しない、と一般に知られているが、
  **本リポジトリでは実測していない**（切り替え時に確認する）。
- 開発者は README を読まないと `localhost` で 200ms を踏み続ける（読ませる運用でカバー）。
- `src/scripts/sakura-proxy-mock.ts` の `server.listen(PROXY_PORT)` は host 未指定
  （Node 既定のデュアルスタック）で、`localhost:3001` でも遅くならない。不一致だが実害は無い。

## 代替案（却下理由）

- **A: `host: '::'` にする** — 本番の待ち受けを変える変更で、Cloud Run・WebSocket・
  `app.inject` の確認 7 項目を本番前に消化する工数に見合わない。得られるのは開発体験のみ。

## 関連

- `src/index.ts` — 待ち受け箇所
- `docs/tests/runs/2026-08-25-bingo-dynamic-unlock.md` — 実測記録
- `event-support-frontend/.env.example` — フロント側の `127.0.0.1` 指定
