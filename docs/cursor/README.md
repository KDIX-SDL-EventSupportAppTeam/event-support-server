# AI エージェント向けドキュメント

技術詳細の正本は [AGENTS.md](../../AGENTS.md)。概要・構成は [README.md](../../README.md)。

## 役割分担

| ツール | ファイル | 役割 |
|--------|----------|------|
| Claude Code | [CLAUDE.md](../../CLAUDE.md) | 設計・要件定義。**コードは書かない** |
| Cursor | [.cursor/rules/](../../.cursor/rules/) | **実装**。指示に従いコードを書く |
| 共通 | [AGENTS.md](../../AGENTS.md) | 環境変数・エンドポイント・認証・DB |
| 共通 | [docs/ubiquitous-language.md](../../docs/ubiquitous-language.md) | ドメイン用語の正本 |

```
README.md … 概要・アーキテクチャ・ディレクトリ構造
AGENTS.md … API・認証・DB の技術詳細
docs/ubiquitous-language.md … ドメイン用語
    ├── CLAUDE.md      … 設計・要件定義
    └── .cursor/rules/ … 実装（cursor-workflow + ファイル種別 rule）
```

## Cursor rules 一覧

| ファイル | alwaysApply | globs | 内容 |
|----------|-------------|-------|------|
| [cursor-workflow.mdc](../../.cursor/rules/cursor-workflow.mdc) | yes | — | 役割・コマンド・コミット・ドキュメント更新 |
| [project-core.mdc](../../.cursor/rules/project-core.mdc) | yes | — | 境界・アーキテクチャ原則 |
| [ubiquitous-language.mdc](../../.cursor/rules/ubiquitous-language.mdc) | yes | — | ドメイン用語の統一 |
| [api-routes.mdc](../../.cursor/rules/api-routes.mdc) | no | `src/routes/**/*.ts` | ルート実装・レスポンス・認証・バリデーション |
| [typescript.mdc](../../.cursor/rules/typescript.mdc) | no | `**/*.ts` | TypeScript・import 規約 |
| [tests.mdc](../../.cursor/rules/tests.mdc) | no | `tests/**/*.ts` | テスト配置・実行記録 |

## テンプレート

| ファイル | 説明 |
|----------|------|
| [CLAUDE.md.template](./CLAUDE.md.template) | CLAUDE.md 更新用 |
| [rules/_template.mdc](./rules/_template.mdc) | 新規 Cursor rule 用 |

## ルールの追加・更新

Claude / Cursor ともに、繰り返し参照する方針が生まれたら **必要に応じて** rule を追加する。

| ツール | 追加先 | 一覧の更新 |
|--------|--------|------------|
| Claude Code | [CLAUDE.md](../../CLAUDE.md) または `docs/adrs/` | ADR 一覧 |
| 共通 | [docs/ubiquitous-language.md](../../docs/ubiquitous-language.md) | — |
| Cursor | `.cursor/rules/*.mdc` | 本ファイル「Cursor rules 一覧」 |

- 1 トピック = 1 rule / 1 ADR。詳細は [AGENTS.md](../../AGENTS.md) に書き、rule には要約のみ
- テンプレート: [rules/_template.mdc](./rules/_template.mdc)
