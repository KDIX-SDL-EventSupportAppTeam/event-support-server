-- users テーブルに role カラムを追加（既存 DB 向け）
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
-- 01_initial_schema.sql が既に role を持つ新規 DB（docker 初回初期化など）でも
-- 二重に実行されてエラーにならないよう、カラム存在チェックで冪等化する。
-- MySQL 8.0 は ADD COLUMN IF NOT EXISTS 非対応のためストアドプロシージャを使う（03 と同方式）。
DROP PROCEDURE IF EXISTS add_role_to_users;
DELIMITER //
CREATE PROCEDURE add_role_to_users()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'role'
  ) THEN
    ALTER TABLE users
      ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'participant';
  END IF;
END //
DELIMITER ;
CALL add_role_to_users();
DROP PROCEDURE IF EXISTS add_role_to_users;
