---
状態: 確定
最終更新: 2026-09-10
---

# パスワード再設定（issue #125）

**方式: メールでリセットリンクを送る一般的な形**（2026-09-10 決定）。
`email-verification` と同じ構造。ただし**トークン表は別**（`password_reset_tokens`）。
用途が混ざると「確認メールのリンクでパスワードを変えられる」等の事故になる。

## トークン表（migration `15_password_reset.sql`）

```sql
CREATE TABLE password_reset_tokens (
  token      CHAR(64) NOT NULL PRIMARY KEY,   -- randomBytes(32).toString('hex')
  user_id    CHAR(36) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

`db/create-tables.sql` にも同じ定義がある（25 テーブル）。

## API

### POST `/api/v1/auth/forgot-password`

ボディ: `{ event_id, email }`

- **`event_id` が要る。** `users` は `UNIQUE (email, event_id)`。email だけでは利用者を特定できない
- 対象が居ても居なくても **常に 200・同じ文言**を返す（アカウント列挙対策）
- 対象が居る場合だけ、**既存トークンを全部消してから**新規発行し、メールを送る
- 有効期限は **1時間**（確認メールの 24 時間より短い）
- 送信失敗は 500 にせず、ログに残して 200（トークンはログに出さない）

#### メールに載せるリンクの形式

```
<frontend_base>/reset-password/<token>?event=<event_id>
```

- **`token` はパス**（`/reset-password/:token`）。クエリには移さない
- **`?event=<event_id>` を必ず付ける。** 値はリクエストの `event_id`（`encodeURIComponent` を通す）。
  フロントの参加者ログイン画面は独立して存在せず入口が `/e/:eventId` に統合されているため、
  再設定完了後の戻り先を決めるのに `event_id` が要る。別端末・別ブラウザで開かれると
  `localStorage` の控えが無く行き止まりになる（フロントの `ResetPasswordPage` は `?event=` を読む受け口を実装済み）
- `<frontend_base>` の決め方は `config.frontendBaseUrl ?? config.corsOrigin.split(',')[0].trim()`（`lib/url.ts` と同式）

### POST `/api/v1/auth/reset-password`

ボディ: `{ token, password }`

- `token` は `^[0-9a-f]{64}$`、`password` は `z.string().min(8).max(200)`（登録時と同じ）
- 期限切れ・存在しない・使用済みトークンは **410 `TOKEN_EXPIRED`**
- 成功したら `bcrypt.hash(password, 10)` で `users.password_hash` を更新し、
  **そのユーザーのトークンを全部削除**（1回限り）
- **`email_verified_at` は触らない**（確認フローとは別の関心事）

## 既知の制限（この issue では直さない）

**パスワードを変えても既存の JWT は失効しない。** `signAccessToken` に `jti` も
パスワード世代も無く、失効リストも無い。本人がパスワードを忘れた当日の運用には
影響しないが、**盗用対応には使えない**（運営手引き `run-day-guide.md` に明記）。

## 起きてはいけないこと

- メールアドレスの存在が応答（文言・ステータス）から分かること
- トークンをログ・監査ログに出すこと
- **トークンをクエリ文字列に置くこと**（`token` はパス。`?event=` にはしない）
- リンク・トークンを `req.log` などに出すこと（送信失敗時もエラー本文だけ。URL は出さない）
- トークンを使い回せること（1回で無効化）
- `email_verification_tokens` を流用すること
- `event_id` を受け取らずに email だけで引くこと
- リンクに `event_id` を載せ忘れること（別端末で開いた利用者がログイン画面に着けない）
