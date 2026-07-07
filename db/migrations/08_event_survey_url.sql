-- イベントにアンケートURLを追加（issue #52-4 / #58 / #48）
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
-- MySQL 8.0 は ADD COLUMN IF NOT EXISTS 非対応のためストアドプロシージャを使う（02 と同方式）。
DROP PROCEDURE IF EXISTS add_survey_url_to_events;
DELIMITER //
CREATE PROCEDURE add_survey_url_to_events()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'events'
      AND COLUMN_NAME  = 'survey_url'
  ) THEN
    ALTER TABLE events
      ADD COLUMN survey_url VARCHAR(2048) NULL;
  END IF;
END //
DELIMITER ;
CALL add_survey_url_to_events();
DROP PROCEDURE IF EXISTS add_survey_url_to_events;
