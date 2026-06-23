# Architecture Decision Records

設計上の重要な判断を短い ADR として残す。  
新規 ADR は **`docs/legacy/adrs/` ではなく本ディレクトリ** に追加する。

## ファイル名

```
NNNN-kebab-case-title.md
```

`NNNN` は 4 桁の連番（例: `0001-use-fastify.md`）。

## テンプレート（目安）

1. タイトル・日付・ステータス（提案 / 承認 / 廃止）
2. コンテキスト（なぜ決める必要があったか）
3. 決定
4. 結果・トレードオフ

## 一覧

| 番号 | ファイル | 概要 |
|------|----------|------|
| 0001 | [0001-sakura-proxy-error-masking.md](./0001-sakura-proxy-error-masking.md) | さくらプロキシは DB エラーを 500 に潰すため、一意制約は INSERT 前に確認する |
| 0002 | [0002-cloud-run-single-instance-for-websocket.md](./0002-cloud-run-single-instance-for-websocket.md) | WebSocket 配信のため Cloud Run を 1 インスタンスに固定する |

## 関連

- [AGENTS.md](../../AGENTS.md) — ドキュメント運用
- [docs/legacy/adrs/](../legacy/adrs/) — モノレポ移行元（参照のみ）
