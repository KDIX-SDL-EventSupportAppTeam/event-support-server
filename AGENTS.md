# event-support-server

イベント支援アプリのサーバー（Fastify + socket.io + MySQL）。
概要・起動手順は [README.md](./README.md)。

## 最初に読むもの

| 知りたいこと | 見る場所 |
|---|---|
| これから何を作るのか | [docs/specs/](./docs/specs/README.md) — **仕様の正本** |
| 今どうなっているのか | [docs/reference/](./docs/reference/README.md) — 環境変数・エンドポイント・認証・DB |
| 何を守るのか | [docs/rules/](./docs/rules/README.md) — Git・実装・テスト・ドキュメント |
| なぜそうなったのか | [docs/decisions/](./docs/decisions/README.md) — ADR・議事録 |
| どう動かすのか | [docs/operations/](./docs/operations/README.md) — デプロイ・さくらプロキシ |
| 言葉の意味 | [docs/ubiquitous-language.md](./docs/ubiquitous-language.md) |

`docs/archive/` は退役した文書。**参照しない。**

## 絶対に守ること

1. **`main` を直接触らない。** 作業ブランチ → `develop` へ PR を出す。
   `develop` → `main` は明示的に指示されたときだけ（[rules/git.md](./docs/rules/git.md)）
2. **本番 DB は HTTP プロキシ経由で 1 リクエスト = 1 SQL。** トランザクションも行ロックも無い。
   排他は条件付き UPDATE の `affectedRows`、INSERT の前に SELECT で重複確認
   （[ADR 0001](./docs/decisions/adrs/0001-sakura-proxy-error-masking.md)）
3. **Cloud Run は 1 インスタンス固定。** socket.io がインメモリのため
   （[ADR 0002](./docs/decisions/adrs/0002-cloud-run-single-instance-for-websocket.md)）
4. **「状態: 確定」でない仕様は実装しない。** `09-open-questions/` は勝手に決めない
5. コミット・PR は**日本語**。テストコードは `tests/` に置き、`src/` に `*.test.ts` を置かない

## よく使うコマンド

```bash
npm run dev        # 開発サーバー
npm test           # Vitest
npm run db:migrate # マイグレーション適用
npm run db:check   # DB 疎通とテーブル数の確認
```

## 関連リポジトリ

| リポジトリ | 役割 |
|---|---|
| `event-support-frontend` | UI。API 契約は本リポジトリの `docs/specs/` が正本 |
| `event-support-recommender` | 推薦エンジン。server から内部 HTTP で中継する |
| `event-support-analytics` | 分析。指標定義はそちらが正本 |
