-- ブース QR の短縮トークン（issue #155）。
-- 掲示 QR を `/checkin?booth_id=<UUID>`（約 70-80 文字）から `/c/<qr_token>`（30 文字前後）へ縮める。
--
-- 依存: 01（booths）
-- 再実行: 可能（列の有無を確認してから追加し、採番は NULL の行だけに行う）
--
-- グローバル一意（event_id を含めない）。URL から event_id を省くための前提。
-- 順序: 列追加（NULL 許可）→ 既存行へ採番 → NOT NULL → UNIQUE。順序を守ること。
--
-- 字母は `23456789ABCDEFGHJKMNPQRSTVWXYZ`（0/O・1/I/L・U を除く 30 種）、10 文字。
-- 既存行の採番は SQL 内の RAND() で行う（暗号論的乱数ではない）。
-- 新規ブースは src/lib/qr-token.ts が randomInt で採番するので、推測耐性が要るのは新規分のみ。
-- 既存行へ採番した後に UNIQUE が張れなければ（偶然の衝突）、もう一度この SQL を流す。

DROP PROCEDURE IF EXISTS add_qr_token_to_booths;
DELIMITER //
CREATE PROCEDURE add_qr_token_to_booths()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'booths'
      AND COLUMN_NAME  = 'qr_token'
  ) THEN
    ALTER TABLE booths ADD COLUMN qr_token CHAR(10) NULL AFTER manual_code;
  END IF;
END //
DELIMITER ;
CALL add_qr_token_to_booths();
DROP PROCEDURE IF EXISTS add_qr_token_to_booths;

-- 既存行へ採番する（NULL の行だけ。再実行しても採番済みの値は変えない）。
UPDATE booths
SET qr_token = CONCAT(
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + FLOOR(RAND() * 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + FLOOR(RAND() * 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + FLOOR(RAND() * 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + FLOOR(RAND() * 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + FLOOR(RAND() * 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + FLOOR(RAND() * 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + FLOOR(RAND() * 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + FLOOR(RAND() * 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + FLOOR(RAND() * 30), 1),
  SUBSTRING('23456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + FLOOR(RAND() * 30), 1)
)
WHERE qr_token IS NULL;

ALTER TABLE booths MODIFY qr_token CHAR(10) NOT NULL;

DROP PROCEDURE IF EXISTS add_qr_token_unique_to_booths;
DELIMITER //
CREATE PROCEDURE add_qr_token_unique_to_booths()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'booths'
      AND INDEX_NAME   = 'uq_booths_qr_token'
  ) THEN
    CREATE UNIQUE INDEX uq_booths_qr_token ON booths (qr_token);
  END IF;
END //
DELIMITER ;
CALL add_qr_token_unique_to_booths();
DROP PROCEDURE IF EXISTS add_qr_token_unique_to_booths;
