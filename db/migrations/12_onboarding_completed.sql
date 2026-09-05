-- オンボーディング既読（単一 URL 状態機械の S5 判定）: users.onboarding_completed_at
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
--
-- 端末ローカル（localStorage）ではなくサーバーに持つ理由:
-- 回答から開放まで数日空くため端末が変わり得る。既読を端末に持つと、
-- PC で回答してスマホで入場した参加者に毎回オンボーディングが出る。
-- users は event_id を持つ（イベントごとに別行）ため、この列だけでイベント単位の既読になる。
--
-- MySQL 8.0 は ADD COLUMN IF NOT EXISTS 非対応のためストアドプロシージャを使う（02 / 07 と同方式）。
DROP PROCEDURE IF EXISTS add_onboarding_completed_at_to_users;
DELIMITER //
CREATE PROCEDURE add_onboarding_completed_at_to_users()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'users'
      AND COLUMN_NAME  = 'onboarding_completed_at'
  ) THEN
    ALTER TABLE users
      ADD COLUMN onboarding_completed_at DATETIME NULL;
  END IF;
END //
DELIMITER ;
CALL add_onboarding_completed_at_to_users();
DROP PROCEDURE IF EXISTS add_onboarding_completed_at_to_users;
