# テスト実行記録 — 2026-10-13（ガチャコイン使用履歴 API と used_at の UTC 化）

## 何を

### 対象（src）

- `src/routes/v1/gacha.ts`
- `src/lib/gacha/useCoin.ts`

### テストコード（tests）

- `tests/integration/gacha/history.test.ts`（新規 5 件）

## なぜ

- server #202。0 枚時の履歴画面（frontend #221）が呼ぶ API の追加と、`used_at` が DB 既定値（さくらでは JST）で入るずれの是正

## 実行コマンド

```bash
npm test
npx tsc --noEmit
```

## 環境

- ブランチ: `feat/gacha-coin-history`
- MySQL: 起動済み（docker compose、タイムゾーン +00:00）

## 結果

- `tests/integration/gacha` 38 件成功（うち新規 5 件）
- `npm test` 全体: 979 成功。`tests/unit/socket-logging.test.ts` のみ失敗（ローカルに `socket.io-client` が無く load できない。変更前でも同じ）
- `tsc --noEmit` エラーなし

## メモ

- ローカル MySQL は UTC なので「DB 既定値が JST」のずれ自体は再現できない。テストは「`used_at` が実時刻（UTC）の範囲に入ること」で担保している
