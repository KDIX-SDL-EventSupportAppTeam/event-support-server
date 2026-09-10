-- パスワード再設定トークン（issue #125）: password_reset_tokens
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
--
-- email_verification_tokens とは別表にする。用途が混ざると
-- 「確認メールのリンクでパスワードを変えられる」等の事故につながる。
-- 有効期限はコード側で 1 時間（PASSWORD_RESET_TOKEN_TTL_HOURS）。
--
-- 依存: 01（users）
-- 再実行: CREATE TABLE IF NOT EXISTS なので 2 回流しても無害

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token      CHAR(64) NOT NULL PRIMARY KEY,
  user_id    CHAR(36) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
