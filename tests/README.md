# ルート `tests/` — テストコード

Vitest で `src/` のロジックを検証する。  
**テストコードはリポジトリ直下の `tests/` にまとめる。** `src/` 内に `*.test.ts` を置かない。

実行記録・フィクスチャのドキュメントは [docs/tests/](../docs/tests/README.md) に残す。

## ディレクトリ

| パス | 用途 |
|------|------|
| `unit/` | 関数・モジュール単位（`lib/`・バリデーション等） |
| `integration/` | ルート登録・DB 接続などのスモーク |

## コマンド

```bash
npm test              # ルート（vitest.config.ts）
npm run test:watch    # ウォッチ
npm run build         # TypeScript ビルド確認
```

## 新規テストを追加するとき

1. `tests/unit/` または `tests/integration/` に `*.test.ts` を追加
2. [docs/tests/runs/_template.md](../docs/tests/runs/_template.md) をコピーし、`docs/tests/runs/` に実行記録を残す
3. 記録に **追加したテストファイルのパス** と **対象の `src/` ファイル** を書く
4. [docs/tests/README.md](../docs/tests/README.md) の記録一覧を更新

## import

相対パスまたは `src/` への相対 import を使う（パスエイリアス `@/` は未使用）。ESM では `.js` 拡張子に注意。
