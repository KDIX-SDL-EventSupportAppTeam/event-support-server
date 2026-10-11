# テスト実行記録 — 2026-10-11 ops Webhook のタグ重複・更新時のタグ消失（#175）

## 何を

### 対象（src）

- `src/routes/v1/ops.ts`

### テストコード（tests）

- `tests/integration/ops/webhook-tags.test.ts`（新規）

## なぜ

#175。`tags: ["AI","AI"]` が `uq_booth_tag` で INSERT 失敗 → 本番では 500。さらに更新経路は
`DELETE` → `INSERT` の順だったため、INSERT が失敗すると古いタグが消えたままになっていた。

## 実行コマンド

```bash
docker compose up -d mysql
npx vitest run tests/integration/ops
npm test
npx tsc --noEmit
```

## 環境

- ブランチ: `fix/175-ops-webhook-tags`
- MySQL: 起動済み（docker compose の mysql:8.0）
- 関連 Issue: #175

## 結果

- 修正前: 6 件中 4 件失敗。修正後: 6 件通過。
- 「更新中に booth_tags への INSERT が失敗しても古いタグが残る」ことを、INSERT だけ失敗させる DbClient で確認。

## メモ

- 本番プロキシは 1 リクエスト = 1 SQL でトランザクションが使えない。そのため「新タグを INSERT → 新タグに無いものだけ DELETE」の順にした（途中失敗しても古いタグが残る）。
- INSERT は `ON DUPLICATE KEY UPDATE tag = tag`。照合順序が大文字小文字を区別しないため、重複除去（大文字小文字無視）で漏れた場合も例外にしない。
- `docs/tests/README.md` の記録一覧への追記は他 PR との衝突回避のため未実施。
