# Cursor 向け指示書

このディレクトリは Cursor（実装担当）向けのルール配置を説明する。

## 読む順序

1. [README.md](../../README.md) — リポジトリの責務・アーキテクチャ・ディレクトリ構造・起動手順
2. [AGENTS.md](../../AGENTS.md) — 環境変数・エンドポイント・認証・DB
3. [.cursor/rules/](../../.cursor/rules/) — 実装時に常に適用する Cursor ルール

設計・要件定義は [CLAUDE.md](../../CLAUDE.md) を参照（Claude Code 向け）。

## ルール一覧

| ファイル | 内容 |
|----------|------|
| [project-core.mdc](../../.cursor/rules/project-core.mdc) | 責務境界・ルート構成・ドキュメント正本 |
| [cursor-workflow.mdc](../../.cursor/rules/cursor-workflow.mdc) | 役割・コマンド実行・コミット・ドキュメント更新 |

## ルールの追加

新しい `.mdc` を `.cursor/rules/` に追加したら、上記一覧を更新する。

- `alwaysApply: true` — プロジェクト全体に常時適用（現状はすべて true）
- `globs` — 特定ファイルパターンにのみ適用する場合に指定

## 関連

- 詳細設計: [docs/legacy/designs/](../legacy/designs/)
- ADR: [docs/legacy/adrs/](../legacy/adrs/)
