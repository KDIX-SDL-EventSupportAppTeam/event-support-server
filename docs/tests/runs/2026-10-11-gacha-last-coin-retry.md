# テスト実行記録 — 2026-10-11 ガチャ：最後のコインの再送で 409 にならない（#172）

## 何を

### 対象（src）

- `src/lib/gacha/useCoin.ts`

### テストコード（tests）

- `tests/integration/gacha/use-coin.test.ts`（C-2b を追加）

## なぜ

#172。残高 1 枚で使用成功した直後に同じ冪等キーを再送すると、`HAVING` 不成立（affectedRows=0）が
そのまま `no_coins` になり 409 NO_COINS_AVAILABLE を返していた。結果（`coin_index`）を失う。

## 実行コマンド

```bash
docker compose up -d mysql
npx vitest run tests/integration/gacha
npm test
npx tsc --noEmit
```

## 環境

- ブランチ: `fix/172-gacha-idempotent-retry`
- MySQL: 起動済み（docker compose の mysql:8.0）
- 関連 Issue: #172

## 結果

- 修正前: C-2b「同じキー 2 回」が失敗（再現）。修正後: 通過。
- 「別キー 2 回 → 2 回目は 409」も通過（再送扱いが広がっていないこと）。
- `npm test`: 935 件通過。`tests/unit/socket-logging.test.ts` のみ `socket.io-client` 未インストールでロード失敗（本件と無関係の環境問題）。

## メモ

`docs/tests/README.md` の記録一覧への追記は、他 PR との衝突を避けるため未実施。
