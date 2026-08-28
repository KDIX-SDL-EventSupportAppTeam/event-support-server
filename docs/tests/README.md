# テスト（`docs/tests`）

このリポジトリのテストは **コード** と **ドキュメント** を分けて管理する。

| 場所 | 役割 |
|------|------|
| [`tests/`](../../tests/) | Vitest のテストコード（`unit/`・`integration/`） |
| `docs/tests/runs/` | 実行記録（何を・なぜ・結果） |
| `docs/tests/fixtures/` | ダミーデータ・ログイン例・再現用の固定値 |

テストコードは **`tests/` にまとめる**。`src/` 内に `*.test.ts` を置かない。  
実行後は必ず `docs/tests/runs/` に記録を残し、本ファイルの「記録一覧」を更新する。

詳細なコマンドは [tests/README.md](../../tests/README.md) を参照。

---

## テストするときの流れ

1. [`tests/unit/`](../../tests/unit/) または [`tests/integration/`](../../tests/integration/) に `*.test.ts` を追加・変更
2. ビルド・テストを実行

   ```bash
   npm run build
   npm test
   ```

3. [runs/_template.md](./runs/_template.md) をコピーし、`docs/tests/runs/YYYY-MM-DD-kebab-case-summary.md` を作成
4. 記録に **対象 `src/` ファイル** と **`tests/**/*.test.ts` のパス** を書く
5. 下記「記録一覧」を 1 行追加

PR 作成時は [AGENTS.md](../../AGENTS.md) の「次にやること」も合わせて更新する。

---

## ディレクトリ

| パス | 用途 |
|------|------|
| [runs/](./runs/) | 実行記録（1 回の作業 = 1 ファイル） |
| [fixtures/](./fixtures/) | 再現用の固定値（ログイン例・event_id 等） |

### ファイル名（runs）

```
YYYY-MM-DD-kebab-case-summary.md
```

### テンプレート

[runs/_template.md](./runs/_template.md)

---

## 記載の目安（runs）

| 項目 | 書くこと |
|------|----------|
| **何を** | 対象 `src/` ファイル、追加・変更した `tests/**/*.test.ts`、実行コマンド |
| **なぜ** | 対応する Issue / ADR / 不具合 |
| **結果** | 成功 / 失敗の要約。失敗時はログ抜粋と再現手順 |
| **環境** | ブランチ、MySQL の有無、関連 PR / Issue |

---

## 現在のテストコード一覧

| テストコード | 種別 | 主な対象（src） | 備考 |
|--------------|------|-----------------|------|
| `tests/unit/datetime.test.ts` | unit | `src/lib/datetime.ts` | UTC 変換の基礎テスト |

新規テストを追加したら、この表も更新する。

---

## 記録一覧

| 日付 | ファイル | 概要 | テストコード |
|------|----------|------|--------------|
| 2026-06-09 | [2026-06-09-sakura-db-proxy-manual.md](./runs/2026-06-09-sakura-db-proxy-manual.md) | さくらDBプロキシ手動検証 | なし（手動） |
| 2026-07-07 | [2026-07-07-comment-save-fetch-api.md](./runs/2026-07-07-comment-save-fetch-api.md) | ブースコメント保存・取得API #54 | `tests/unit/booth-comments.test.ts` |
| 2026-07-07 | [2026-07-07-exhibitor-role-stats-api.md](./runs/2026-07-07-exhibitor-role-stats-api.md) | 出展者ロール・一括登録API・集計API #53 | `tests/unit/exhibitor.test.ts` |
| 2026-07-12 | [2026-07-12-admin-booth-sort.md](./runs/2026-07-12-admin-booth-sort.md) | 運営向けブース別ソート付き一覧・集計API #55 | `tests/unit/admin-booth-sort.test.ts` |
| 2026-07-12 | [2026-07-12-organizer-event-data.md](./runs/2026-07-12-organizer-event-data.md) | イベントデータ全削除の organizer 専用エンドポイント再設計 | `tests/unit/organizer-event-data.test.ts` |
| 2026-07-13 | [2026-07-13-email-verification.md](./runs/2026-07-13-email-verification.md) | メールアドレス本人確認 #57 | `tests/unit/email-verification.test.ts` |
| 2026-07-13 | [2026-07-13-event-survey-url.md](./runs/2026-07-13-event-survey-url.md) | イベントにアンケートURL追加 | — |
| 2026-07-13 | [2026-07-13-organizer-auth-disabled.md](./runs/2026-07-13-organizer-auth-disabled.md) | 主催者ポータルの本番アクセス制限 #56 | `tests/unit/organizer-auth.test.ts` |
| 2026-08-25 | [2026-08-25-bingo-dynamic-unlock.md](./runs/2026-08-25-bingo-dynamic-unlock.md) | **ビンゴ動的段階解放の実装と検証**（仕様変更対応・性能計測・環境問題） | `tests/unit/bingo-*.test.ts` ほか |

---

## フィクスチャ（fixtures）

| ファイル | 内容 |
|----------|------|
| [fixtures/dummy-login.md](./fixtures/dummy-login.md) | 開発用ログイン・event_id（`db:seed` と同期） |

---

## レガシー

モノレポ時代の実行記録は [docs/archive/legacy/](../archive/legacy/) にある（参照のみ）。新規記録は `docs/tests/runs/` に追加する。

---

## 関連ドキュメント

- [tests/README.md](../../tests/README.md) — テストコードの置き場所・コマンド
- [AGENTS.md](../../AGENTS.md) — エージェント向けテスト規約
- [docs/decisions/adrs/](../decisions/adrs/) — 設計判断（テスト方針の ADR はここへ）
