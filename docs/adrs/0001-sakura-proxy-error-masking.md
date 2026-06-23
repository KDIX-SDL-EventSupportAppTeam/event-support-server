# 0001. さくらプロキシは DB エラーを 500 に潰すため、一意制約は INSERT 前に確認する

- 日付: 2026-06-24
- ステータス: 承認

## コンテキスト

本番 DB はさくら上の PHP ラッパー API（`SAKURA_PROXY_URL`）経由でアクセスする。
このプロキシは MySQL のエラーをそのまま返さず、**すべて HTTP 500 `{"error":"Internal Server Error"}` に潰して**返す（`src/scripts/sakura-proxy-mock.ts` も同じ契約）。

そのため `src/db/http-proxy.ts` は汎用 `Error` を投げるしかなく、`err.code`（例: `ER_DUP_ENTRY`）を持たない。

これにより、`try { INSERT } catch (e) { if (e.code === 'ER_DUP_ENTRY') 409 }` という
mysql2 前提の重複検知が**プロキシ経由では一切機能しない**。実際、

- 同じブースへの再チェックイン（`uq_checkin_user_booth`）
- 同じチェックインへの再評価（`uq_rating_per_checkin`）
- 重複メール登録（`uq_email_event`）

がいずれも 409 ではなく 500（画面では「サーバーエラーが発生しました」）になっていた。

## 決定

**一意制約に依存する操作は、INSERT 前に `SELECT ... LIMIT 1` で重複を明示確認し、
あれば 409 を返す。** `catch (ER_DUP_ENTRY)` はローカル mysql2 経路・競合時の
フォールバックとして残す（多重防御）。

適用箇所:
- `src/routes/v1/checkins.ts` — チェックイン / 評価
- `src/routes/v1/auth.ts` — 一般登録 / 運営登録

## 結果・トレードオフ

- 重複時に正しく 409 と意味のあるメッセージを返せる。
- SELECT が 1 回増える（軽量）。同時リクエストでの競合は残るが、その場合のみ
  フォールバックの 500 になる稀ケースで許容。
- **新しく一意制約を持つテーブルへ INSERT する時は、必ず同じ事前確認を入れること。**
  プロキシがエラーコードを返さない限り、この制約は残る。

## 関連

- [http-proxy.ts](../../src/db/http-proxy.ts) — 型正規化（boolean→0/1, Date→DATETIME）もここに集約
- [さくら DB プロキシ実装メモ](../orders/2026-06-09-完了-さくらDB接続WebAPIプロキシ実装.md)
