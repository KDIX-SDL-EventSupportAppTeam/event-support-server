# テスト

## 置き場

| 場所 | 役割 |
|---|---|
| [`tests/`](../../tests/) | Vitest のテストコード（`unit/`・`integration/`）。**ここにまとめる** |
| [`docs/tests/`](../tests/) | 実行記録（`runs/`）・フィクスチャ（`fixtures/`） |

- `src/` 内に `*.test.ts` を置かない
- 実行: `npm test`

## 記録

テストを追加・実行したら [docs/tests/runs/_template.md](../tests/runs/_template.md) に沿って
`docs/tests/runs/` に記録を残し、対象の `src/` ファイルと `tests/**/*.test.ts` のパスを書く。

## 書き方

- **「起きるべきこと」だけでなく「起きてはいけないこと」を書く。** 後者が抜けやすい
- DB や外部通信に依存しない純関数として切り出せる部分は、切り出してから単体テストする
- 機能ごとのテスト計画と合格基準は `docs/specs/<機能>/10-testing/` に置く
