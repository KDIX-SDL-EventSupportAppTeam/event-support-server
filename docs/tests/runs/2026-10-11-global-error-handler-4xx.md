# テスト実行記録 — 2026-10-11 グローバルエラーハンドラーが 4xx を 500 にしない（#174）

## 何を

### 対象（src）

- `src/lib/error-handler.ts`（新規。`app.ts` の `setErrorHandler` から切り出し）
- `src/app.ts`

### テストコード（tests）

- `tests/unit/error-handler.test.ts`（新規）

## なぜ

#174。Fastify が付ける 4xx（不正 JSON・本文サイズ超過・未対応 Content-Type）まで 500 `INTERNAL_ERROR` になり、
クライアントの誤りがサーバー障害に見えていた（ログも error で、監視のノイズになる）。

## 実行コマンド

```bash
npx vitest run tests/unit/error-handler.test.ts
npm test
npx tsc --noEmit
```

## 環境

- ブランチ: `fix/174-error-handler-4xx`
- MySQL: 未使用
- 関連 Issue: #174

## 結果

- 不正 JSON → 400 `BAD_REQUEST`（ログは warn のみ）／413 `PAYLOAD_TOO_LARGE`／415 `UNSUPPORTED_MEDIA_TYPE`／例外を投げるルート → 500 `INTERNAL_ERROR`（内部メッセージを返さない・ログは error）。
- 対応表に無い 4xx（418）も 4xx のまま返す。
- ルートの zod `safeParse` は従来どおり 422 を直接返しており、このハンドラーを通らない（応答形は変更なし）。

## メモ

`docs/tests/README.md` の記録一覧への追記は他 PR との衝突回避のため未実施。
