# テスト実行記録 — 2026-07-13（メールアドレス本人確認 #57 実装）

## 何を

### 対象（src）

- `src/config.ts`（SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/MAIL_FROM 追加）
- `src/lib/mailer.ts`（新規。SMTP 実送信 or ログ出力モードの `Mailer`）
- `src/lib/email-verification.ts`（新規。トークン発行・確認URL組み立て・メール本文）
- `src/plugins/auth.ts`（`requireVerifiedEmail` 追加）
- `src/routes/v1/auth.ts`（register フック・`GET /verify-email`・`POST /resend-verification`・login/register 応答への `email_verified` 追加）
- `src/routes/v1/checkins.ts`（POST checkins の preHandler に `requireVerifiedEmail` を追加）
- `src/app.ts`（`app.decorate('mailer', ...)` 追加）
- `src/types/fastify.d.ts`（`mailer: Mailer` 追加）
- `src/scripts/seed-dev.ts`（dev ユーザーを確認済みで作成・既存ユーザーは早期 return 側で UPDATE）

### テストコード（tests）

- `tests/unit/email-verification.test.ts`（新規・12 ケース）

## なぜ

server issue #57（`server_57_メール確認API.md`）。参加者のセルフ登録に確認メールを追加し、捨てメール・スパム登録を抑止する。未確認 participant はチェックインのみ制限（A案）。

## 実行コマンド

```bash
npm run build
npm test
npm run db:seed
```

## 環境

- ブランチ: `feat/email-verification`
- MySQL: Docker 起動済み（`event-support-mysql`）。`npm run db:check` で 15 テーブル確認済み（#52 適用済み）
- 関連 PR / Issue: #57（対応フロント #47）

## 結果

- `npm run build` → exit 0（tsc エラーなし）
- `npm test` → 5 ファイル / 36 ケース全て green（うち本 issue 分は `email-verification.test.ts` の 12 ケース）
  - register 成功でトークン INSERT・メール送信・`email_verified:false` 応答
  - register で送信失敗（throw）しても登録は 200 のまま
  - `GET /verify-email`: 有効トークン→200＋UPDATE/DELETE、未知トークン→404 TOKEN_INVALID、期限切れ→410 TOKEN_EXPIRED＋DELETE、形式不正→422 VALIDATION_ERROR
  - `POST /resend-verification`: 未確認→旧トークンDELETE→新規INSERT→送信、確認済み→409 ALREADY_VERIFIED、Bearer無し→401
  - `requireVerifiedEmail`: 未確認 participant→403 EMAIL_NOT_VERIFIED、確認済み participant→素通り（後続の 422 まで到達）、未確認 manager→素通り
- `npm run db:seed` → 既存 dev ユーザー（`dev@example.com`）に対して early-return 側の UPDATE が実行され、`email_verified_at` が `2026-07-12 18:43:14`（非NULL）に更新されたことを SQL で確認

## メモ

- ローカル Docker での実 API 疎通（`curl` による §8 の手順）は今回未実施。ユニットテスト（DbClient モック）と `db:seed` の DB 実測で完了条件をカバーしている。実 API 経路での確認は次回の統合検証で行う。
- さくら本番デプロイ時の移行措置 SQL は `改修プラン/三上issue_2026-07/deliverables/さくら適用_57_既存ユーザー確認済み化.sql` に作成済み（repo外）。実行順序は UPDATE → サーバーデプロイの順を厳守。
