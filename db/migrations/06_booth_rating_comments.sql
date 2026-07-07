-- booth_ratings にコメント欄と表示制御フラグを追加（issue #52-2 / #54 / #44）
-- 保存方式は booth_ratings 拡張案を採用（booth_comments 新設は不採用。設計書 §3）。
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
-- MySQL 8.0 は ADD COLUMN IF NOT EXISTS 非対応のためストアドプロシージャを使う（02 と同方式）。
DROP PROCEDURE IF EXISTS add_comment_to_booth_ratings;
DELIMITER //
CREATE PROCEDURE add_comment_to_booth_ratings()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'booth_ratings'
      AND COLUMN_NAME  = 'comment'
  ) THEN
    ALTER TABLE booth_ratings
      ADD COLUMN comment   TEXT NULL,
      ADD COLUMN is_hidden TINYINT(1) NOT NULL DEFAULT 0;
  END IF;
END //
DELIMITER ;
CALL add_comment_to_booth_ratings();
DROP PROCEDURE IF EXISTS add_comment_to_booth_ratings;
