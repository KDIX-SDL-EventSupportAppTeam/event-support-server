# テスト実行記録 — 2026-10-11 本番プロキシでエラーコードが消えても重複を 409 / null にする（#173）

## 何を

### 対象（src）

- `src/lib/bingo/unlock.ts`（`tryClaimPair`。テストのため export）
- `src/routes/v1/checkins.ts`（チェックイン INSERT・評価 INSERT）

### テストコード（tests）

- `tests/integration/masked-errors/dup-entry.test.ts`（新規）
- `tests/unit/bingo-unlock.test.ts`（「sakura 相当」の期待を「敗者も落ちない」に更新）

## なぜ

#173 / ADR 0001。本番プロキシは DB エラーを 500 に潰し `err.code` が無いため、`ER_DUP_ENTRY` 分岐だけでは
同時リクエストの敗者が 500 になる。例外時に再 SELECT して状態で判定する形に直した（`ER_DUP_ENTRY` 分岐は撤去し、再 SELECT に一本化）。

## 実行コマンド

```bash
docker compose up -d mysql
npx vitest run tests/integration/masked-errors
npm test
npx tsc --noEmit
```

## 環境

- ブランチ: `fix/173-dup-entry-masked`
- MySQL: 起動済み（docker compose の mysql:8.0。migration 20・21 を手で適用した状態）
- 関連 Issue: #173

## 結果

- テストは DbClient を包んでエラーを「コード無しの Error」に作り替え、事前 SELECT を 2 本が揃うまで保留して INSERT を必ず競合させる。
- 修正前: 4 件中 3 件失敗（解放ペア確保が例外／チェックイン・評価の敗者が 500）。修正後: 4 件通過。
- 「重複とは無関係の失敗（FK 違反）は再 throw する」ことも確認。

## メモ

- 実機プロキシ（さくら）での再現は未確認。ローカルでの模擬のみ。
- `docs/tests/README.md` の記録一覧への追記は他 PR との衝突回避のため未実施。
