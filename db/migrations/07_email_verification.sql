-- メールアドレス本人確認（issue #52-3 / #57）: users.email_verified_at + トークン表
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
-- MySQL 8.0 は ADD COLUMN IF NOT EXISTS 非対応のためストアドプロシージャを使う（02 と同方式）。
DROP PROCEDURE IF EXISTS add_email_verified_at_to_users;
DELIMITER //
CREATE PROCEDURE add_email_verified_at_to_users()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'email_verified_at'
  ) THEN
    ALTER TABLE users
      ADD COLUMN email_verified_at DATETIME NULL;
  END IF;
END //
DELIMITER ;
CALL add_email_verified_at_to_users();
DROP PROCEDURE IF EXISTS add_email_verified_at_to_users;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token      CHAR(64)  NOT NULL PRIMARY KEY,
  user_id    CHAR(36)  NOT NULL,
  expires_at DATETIME  NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
