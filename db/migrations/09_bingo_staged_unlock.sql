-- ビンゴカード段階解放方式（docs/.sdd/02-data-model/migration.md）
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
-- MySQL 8.0 は ADD COLUMN IF NOT EXISTS 非対応のためストアドプロシージャを使う（02/03/08 と同方式）。

SET NAMES utf8mb4;

-- =============================================================================
-- 1. booths.is_active（当日中止フラグ。E5）
-- =============================================================================
DROP PROCEDURE IF EXISTS add_is_active_to_booths;
DELIMITER //
CREATE PROCEDURE add_is_active_to_booths()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'booths'
      AND COLUMN_NAME  = 'is_active'
  ) THEN
    ALTER TABLE booths
      ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1;
  END IF;
END //
DELIMITER ;
CALL add_is_active_to_booths();
DROP PROCEDURE IF EXISTS add_is_active_to_booths;

-- =============================================================================
-- 2. bingo_cards → bingo_cells → cell_assignment_logs（FK 依存順）
-- =============================================================================
CREATE TABLE IF NOT EXISTS bingo_cards (
  id          CHAR(36) PRIMARY KEY,
  event_id    CHAR(36) NOT NULL,
  user_id     CHAR(36) NOT NULL,
  status      ENUM('CENTER_ONLY','UNLOCKED') NOT NULL DEFAULT 'CENTER_ONLY',
  unlocked_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_card_event_user (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bingo_cells (
  id          CHAR(36) PRIMARY KEY,
  card_id     CHAR(36) NOT NULL,
  position    TINYINT  NOT NULL,
  zone        ENUM('CENTER','OUTER') NOT NULL,
  booth_id    CHAR(36) NULL,
  state       ENUM('LOCKED','EMPTY','ACHIEVED') NOT NULL,
  source      ENUM('SIGNUP_BONUS','FREE_VISIT','RECOMMEND') NULL,
  assigned_at DATETIME NULL,
  achieved_at DATETIME NULL,
  UNIQUE KEY uq_cell_card_position (card_id, position),
  UNIQUE KEY uq_cell_card_booth (card_id, booth_id),
  FOREIGN KEY (card_id)  REFERENCES bingo_cards(id) ON DELETE CASCADE,
  FOREIGN KEY (booth_id) REFERENCES booths(id)      ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS cell_assignment_logs (
  id                   CHAR(36)    PRIMARY KEY,
  cell_id              CHAR(36)    NOT NULL,
  strategy             VARCHAR(32) NOT NULL,
  score                DOUBLE      NULL,
  reason_payload       JSON        NULL,
  global_checkin_count INT         NOT NULL,
  created_at           DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (cell_id) REFERENCES bingo_cells(id) ON DELETE CASCADE
);

-- =============================================================================
-- 3. booths に出展者ヒアリングの2項目（Q-6: NULL 許容のまま運用する）
-- =============================================================================
DROP PROCEDURE IF EXISTS add_duration_band_to_booths;
DELIMITER //
CREATE PROCEDURE add_duration_band_to_booths()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'booths'
      AND COLUMN_NAME  = 'duration_band'
  ) THEN
    ALTER TABLE booths
      ADD COLUMN duration_band ENUM('SHORT','MID','LONG') NULL;
  END IF;
END //
DELIMITER ;
CALL add_duration_band_to_booths();
DROP PROCEDURE IF EXISTS add_duration_band_to_booths;

DROP PROCEDURE IF EXISTS add_knowledge_level_to_booths;
DELIMITER //
CREATE PROCEDURE add_knowledge_level_to_booths()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'booths'
      AND COLUMN_NAME  = 'knowledge_level'
  ) THEN
    ALTER TABLE booths
      ADD COLUMN knowledge_level ENUM('NONE','HELPFUL','REQUIRED') NULL;
  END IF;
END //
DELIMITER ;
CALL add_knowledge_level_to_booths();
DROP PROCEDURE IF EXISTS add_knowledge_level_to_booths;

-- =============================================================================
-- 4. check_ins に visit_order / cell_id / INDEX を追加
--    （cell_id の FK は bingo_cells 作成後）
-- =============================================================================
DROP PROCEDURE IF EXISTS add_visit_order_to_check_ins;
DELIMITER //
CREATE PROCEDURE add_visit_order_to_check_ins()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'check_ins'
      AND COLUMN_NAME  = 'visit_order'
  ) THEN
    ALTER TABLE check_ins
      ADD COLUMN visit_order INT NOT NULL DEFAULT 0;
  END IF;
END //
DELIMITER ;
CALL add_visit_order_to_check_ins();
DROP PROCEDURE IF EXISTS add_visit_order_to_check_ins;

DROP PROCEDURE IF EXISTS add_cell_id_to_check_ins;
DELIMITER //
CREATE PROCEDURE add_cell_id_to_check_ins()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'check_ins'
      AND COLUMN_NAME  = 'cell_id'
  ) THEN
    ALTER TABLE check_ins
      ADD COLUMN cell_id CHAR(36) NULL;
  END IF;
END //
DELIMITER ;
CALL add_cell_id_to_check_ins();
DROP PROCEDURE IF EXISTS add_cell_id_to_check_ins;

DROP PROCEDURE IF EXISTS add_fk_checkin_cell;
DELIMITER //
CREATE PROCEDURE add_fk_checkin_cell()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA    = DATABASE()
      AND TABLE_NAME      = 'check_ins'
      AND CONSTRAINT_NAME = 'fk_checkin_cell'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE check_ins
      ADD CONSTRAINT fk_checkin_cell FOREIGN KEY (cell_id) REFERENCES bingo_cells(id) ON DELETE SET NULL;
  END IF;
END //
DELIMITER ;
CALL add_fk_checkin_cell();
DROP PROCEDURE IF EXISTS add_fk_checkin_cell;

DROP PROCEDURE IF EXISTS add_idx_checkin_event_time;
DELIMITER //
CREATE PROCEDURE add_idx_checkin_event_time()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME    = 'check_ins'
      AND INDEX_NAME    = 'idx_checkin_event_time'
  ) THEN
    ALTER TABLE check_ins ADD INDEX idx_checkin_event_time (event_id, checked_in_at);
  END IF;
END //
DELIMITER ;
CALL add_idx_checkin_event_time();
DROP PROCEDURE IF EXISTS add_idx_checkin_event_time;

DROP PROCEDURE IF EXISTS add_idx_checkin_event_booth;
DELIMITER //
CREATE PROCEDURE add_idx_checkin_event_booth()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME    = 'check_ins'
      AND INDEX_NAME    = 'idx_checkin_event_booth'
  ) THEN
    ALTER TABLE check_ins ADD INDEX idx_checkin_event_booth (event_id, booth_id);
  END IF;
END //
DELIMITER ;
CALL add_idx_checkin_event_booth();
DROP PROCEDURE IF EXISTS add_idx_checkin_event_booth;

-- =============================================================================
-- 5. booth_ratings に prompt_context / scale を追加、rating の CHECK を削除
-- =============================================================================
DROP PROCEDURE IF EXISTS add_prompt_context_to_booth_ratings;
DELIMITER //
CREATE PROCEDURE add_prompt_context_to_booth_ratings()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'booth_ratings'
      AND COLUMN_NAME  = 'prompt_context'
  ) THEN
    ALTER TABLE booth_ratings
      ADD COLUMN prompt_context ENUM('NEXT_CHECKIN','MANUAL') NOT NULL DEFAULT 'MANUAL';
  END IF;
END //
DELIMITER ;
CALL add_prompt_context_to_booth_ratings();
DROP PROCEDURE IF EXISTS add_prompt_context_to_booth_ratings;

DROP PROCEDURE IF EXISTS add_scale_to_booth_ratings;
DELIMITER //
CREATE PROCEDURE add_scale_to_booth_ratings()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'booth_ratings'
      AND COLUMN_NAME  = 'scale'
  ) THEN
    ALTER TABLE booth_ratings
      ADD COLUMN scale TINYINT NOT NULL DEFAULT 5;
  END IF;
END //
DELIMITER ;
CALL add_scale_to_booth_ratings();
DROP PROCEDURE IF EXISTS add_scale_to_booth_ratings;

-- rating の CHECK (rating BETWEEN 1 AND 5) を削除する。
-- CHECK 制約名は MySQL 8.0 では列定義から自動生成される（booth_ratings_chk_1 など）ため、
-- information_schema.CHECK_CONSTRAINTS から動的に名前を取得して DROP する。
DROP PROCEDURE IF EXISTS drop_rating_check_constraint;
DELIMITER //
CREATE PROCEDURE drop_rating_check_constraint()
BEGIN
  DECLARE chk_name VARCHAR(200);
  DECLARE done INT DEFAULT 0;
  DECLARE cur CURSOR FOR
    SELECT cc.CONSTRAINT_NAME
    FROM information_schema.CHECK_CONSTRAINTS cc
    JOIN information_schema.TABLE_CONSTRAINTS tc
      ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
     AND tc.CONSTRAINT_NAME   = cc.CONSTRAINT_NAME
    WHERE cc.CONSTRAINT_SCHEMA = DATABASE()
      AND tc.TABLE_NAME = 'booth_ratings'
      AND cc.CHECK_CLAUSE LIKE '%rating%';
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO chk_name;
    IF done THEN
      LEAVE read_loop;
    END IF;
    SET @sql := CONCAT('ALTER TABLE booth_ratings DROP CHECK `', chk_name, '`');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END LOOP;
  CLOSE cur;
END //
DELIMITER ;
CALL drop_rating_check_constraint();
DROP PROCEDURE IF EXISTS drop_rating_check_constraint;

-- =============================================================================
-- 6. backfill: check_ins.visit_order（ユーザーごとに checked_in_at 昇順で 1 始まり）
-- =============================================================================
UPDATE check_ins ci
JOIN (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY checked_in_at, id) AS vo
  FROM check_ins
) t ON t.id = ci.id
SET ci.visit_order = t.vo
WHERE ci.visit_order = 0;
