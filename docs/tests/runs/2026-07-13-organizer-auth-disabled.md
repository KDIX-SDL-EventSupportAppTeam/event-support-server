# テスト実行記録 — 2026-07-13（issue #56: 主催者ポータルの本番アクセス制限）

## 何を

### 対象（src）

- `src/config.ts`（`ORGANIZER_SIGNUP_MODE` の zod enum・`AppConfig` 型 union に `'disabled'` を追加）
- `src/routes/v1/organizer/auth.ts`（register ハンドラ先頭に `disabled` → 410 GONE ガードを追加）

### テストコード（tests）

- `tests/unit/organizer-auth.test.ts`（新規。5ケース: disabled 410／キー付きでも 410／disabled でも login は 200／invite キー不一致は 403／invite 正しいキーは 201）

## なぜ

issue #56。合言葉（`x-organizer-key`）を知っていれば誰でもオーガナイザーアカウントを作成できる register エンドポイントを、本番では環境変数ひとつ（`ORGANIZER_SIGNUP_MODE=disabled`）で完全に塞げるようにする。設計書:
`/Users/taiyo/Claude/University/Research/02_コード/P3_2026/改修プラン/三上issue_2026-07/server_56_ポータルセキュリティ.md`

## 実行コマンド

```bash
npm run build
npm test
```

## 環境

- ブランチ: `feat/organizer-signup-disabled`
- MySQL: 未使用（全テストは `DbClient` モック経由。実 DB 起動なし）
- 関連 PR / Issue: #56

## 結果

- 成功。`npm run build` は exit 0（型エラーなし）。
- `npm test`: 5 ファイル・29 テスト全 pass（うち新規 `organizer-auth.test.ts` の 5 ケースを含む）。
- `git diff --stat src/lib/jwt.ts` は空 — issue 完了条件2（JWT 有効期限の明示設定）はコード変更なしで既に満たされていることを確認済み（`expiresIn: 30 * 24 * 3600`、70行）。

```
 ✓ tests/unit/safe-compare.test.ts (5 tests)
 ✓ tests/unit/datetime.test.ts (4 tests)
 ✓ tests/unit/http-proxy.test.ts (3 tests)
 ✓ tests/unit/organizer-portal.test.ts (12 tests)
 ✓ tests/unit/organizer-auth.test.ts (5 tests)

 Test Files  5 passed (5)
      Tests  29 passed (29)
```

## メモ

- ローカルの実サーバー起動による 410/200/403 curl 確認（設計書 §6・§7）は本記録の対象外（機械検査＝ビルド・テストのみ実施）。必要であれば別途実施すること。
- 本番 Cloud Run への `ORGANIZER_SIGNUP_MODE=disabled` 設定（設計書 §5 手順6・運用作業）は本タスクのスコープ外。実施者・タイミングは設計書 §9 未決事項1のとおり要三上確認。
