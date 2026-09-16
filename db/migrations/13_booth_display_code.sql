-- ブースに公開用のブース番号を追加（issue #121）: booths.display_code
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
--
-- QR＋手動コードの2方式に確定したことで manual_code は「参加者に見せない秘密」になった。
-- 参加者に見せるブース番号（小間番号。掲示・ポスター・一覧で使う）を別列に分ける。
-- 既存行は NULL。移行期間は display_code ?? '(未設定)' で描画する。
--
-- MySQL 8.0 は ADD COLUMN IF NOT EXISTS 非対応のためストアドプロシージャを使う（02 / 07 / 12 と同方式）。
DROP PROCEDURE IF EXISTS add_display_code_to_booths;
DELIMITER //
CREATE PROCEDURE add_display_code_to_booths()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'booths'
      AND COLUMN_NAME  = 'display_code'
  ) THEN
    ALTER TABLE booths
      ADD COLUMN display_code VARCHAR(16) NULL AFTER name;
  END IF;
END //
DELIMITER ;
CALL add_display_code_to_booths();
DROP PROCEDURE IF EXISTS add_display_code_to_booths;
