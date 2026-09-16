-- ビンゴカード動的段階解放方式（docs/specs/bingo-dynamic-unlock/02-data-model/migration.md）
-- + 事前アンケート／アプリ公開ゲート（docs/specs/pre-survey/02-data-model.md）
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
-- MySQL 8.0 は ADD COLUMN IF NOT EXISTS 非対応のためストアドプロシージャを使う（02/03/08 と同方式）。
--
-- 本番のさくら DB には旧版（中央4マス一括解放方式）の 09 はまだ適用されていない
-- （テストデータのみ、消してよい）ため、差分適用ではなく作り直しで進める。

SET NAMES utf8mb4;

-- =============================================================================
-- 1. booths.is_active（当日中止フラグ）
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
-- 2. ビンゴ・推薦・ガチャ関連テーブルの作り直し（旧版がある場合は DROP）
--    参照先から参照元への逆順で DROP する（migration.md 「適用順序」）
-- =============================================================================
-- check_ins.cell_id を NULL に落とす（bingo_cells への外部キーを外すため）。
-- cell_id 列は本ファイルの後段（3.）で追加するもので、01〜08 だけを適用した新規 DB には
-- まだ存在しない。Docker init は 01→09 の順で走るため、存在確認してから実行する。
SET FOREIGN_KEY_CHECKS = 0;
DROP PROCEDURE IF EXISTS clear_check_ins_cell_id;
DELIMITER //
CREATE PROCEDURE clear_check_ins_cell_id()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'check_ins'
      AND COLUMN_NAME  = 'cell_id'
  ) THEN
    UPDATE check_ins SET cell_id = NULL;
  END IF;
END //
DELIMITER ;
CALL clear_check_ins_cell_id();
DROP PROCEDURE IF EXISTS clear_check_ins_cell_id;
DROP TABLE IF EXISTS gacha_coin_uses;
DROP TABLE IF EXISTS recommendation_scores;
DROP TABLE IF EXISTS card_unlock_events;
DROP TABLE IF EXISTS cell_assignment_logs;
-- recommendations は既存データごと削除する（D-11）
DROP TABLE IF EXISTS recommendations;
DROP TABLE IF EXISTS bingo_cells;
DROP TABLE IF EXISTS bingo_cards;
SET FOREIGN_KEY_CHECKS = 1;

-- bingo_cards: status / unlocked_at を削除（D-8。段階はマスから導出する）
CREATE TABLE bingo_cards (
  id          CHAR(36) PRIMARY KEY,
  event_id    CHAR(36) NOT NULL,
  user_id     CHAR(36) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_card_event_user (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);

-- bingo_cells: state を is_revealed / is_achieved の2軸へ分解（D-9）。source に PRESURVEY を追加
CREATE TABLE bingo_cells (
  id           CHAR(36)   PRIMARY KEY,
  card_id      CHAR(36)   NOT NULL,
  position     TINYINT    NOT NULL,
  zone         ENUM('CENTER','OUTER') NOT NULL,
  booth_id     CHAR(36)   NULL,
  is_revealed  TINYINT(1) NOT NULL DEFAULT 0,
  is_achieved  TINYINT(1) NOT NULL DEFAULT 0,
  source       ENUM('PRESURVEY','FREE_VISIT','RECOMMEND') NULL,
  assigned_at  DATETIME   NULL,
  achieved_at  DATETIME   NULL,
  UNIQUE KEY uq_cell_card_position (card_id, position),
  UNIQUE KEY uq_cell_card_booth (card_id, booth_id),
  FOREIGN KEY (card_id)  REFERENCES bingo_cards(id) ON DELETE CASCADE,
  FOREIGN KEY (booth_id) REFERENCES booths(id)      ON DELETE RESTRICT
);

-- card_unlock_events（新規・追記専用）: 解放の履歴。UNIQUE(card_id, pair_key) が冪等性の要（D-15）
CREATE TABLE card_unlock_events (
  id                   CHAR(36)    PRIMARY KEY,
  card_id              CHAR(36)    NOT NULL,
  pair_key             VARCHAR(16) NOT NULL, -- 'PRESURVEY'(9文字) を入れるため 16。migration 11 と同期
  line_index           TINYINT     NOT NULL,
  released_positions   VARCHAR(16) NOT NULL,
  phase                VARCHAR(16) NOT NULL,
  strategy             VARCHAR(32) NOT NULL,
  decision_table_size  INT         NULL,
  global_checkin_count INT         NOT NULL,
  created_at           DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_unlock_card_pair (card_id, pair_key),
  FOREIGN KEY (card_id) REFERENCES bingo_cards(id) ON DELETE CASCADE
);

-- recommendation_scores（新規・追記専用）: 除外されていない全候補ブースを1行ずつ記録する（D-10）
CREATE TABLE recommendation_scores (
  id               CHAR(36)   PRIMARY KEY,
  unlock_event_id  CHAR(36)   NOT NULL,
  user_id          CHAR(36)   NOT NULL,
  booth_id         CHAR(36)   NOT NULL,
  score            DOUBLE     NULL,
  rank_in_event    SMALLINT   NULL,
  was_assigned     TINYINT(1) NOT NULL DEFAULT 0,
  interest_match   ENUM('MATCH','PARTIAL','MISMATCH','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  attributes       JSON       NULL,
  reason_payload   JSON       NULL,
  created_at       DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_score_event_booth (unlock_event_id, booth_id),
  INDEX idx_score_user (user_id),
  FOREIGN KEY (unlock_event_id) REFERENCES card_unlock_events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)         REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (booth_id)        REFERENCES booths(id) ON DELETE CASCADE
);

-- gacha_coin_uses（新規・器のみ。D-5: ビンゴはガチャコインに依存しない）
CREATE TABLE gacha_coin_uses (
  id        CHAR(36) PRIMARY KEY,
  event_id  CHAR(36) NOT NULL,
  user_id   CHAR(36) NOT NULL,
  used_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_gacha_event_user (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);

-- =============================================================================
-- 3. check_ins に visit_order / cell_id / INDEX を追加（cell_id の FK は bingo_cells 作成後）
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
-- 4. booth_ratings に prompt_context / scale を追加、rating の CHECK を削除
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
-- 5. backfill: check_ins.visit_order（ユーザーごとに checked_in_at 昇順で 1 始まり）
-- =============================================================================
UPDATE check_ins ci
JOIN (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY checked_in_at, id) AS vo
  FROM check_ins
) t ON t.id = ci.id
SET ci.visit_order = t.vo
WHERE ci.visit_order = 0;

-- =============================================================================
-- 6. 事前アンケート／アプリ公開ゲート（docs/specs/pre-survey/02-data-model.md）
-- =============================================================================

-- event_app_access（新規）。行が無いイベントは mode='closed' 相当として扱う（アプリ側）
CREATE TABLE IF NOT EXISTS event_app_access (
  event_id             CHAR(36)     PRIMARY KEY,
  mode                 VARCHAR(20)  NOT NULL DEFAULT 'closed',
  app_opens_at         DATETIME     NULL,
  app_closes_at        DATETIME     NULL,
  pre_survey_closes_at DATETIME     NULL,
  updated_by           CHAR(36)     NULL,
  updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CHECK (mode IN ('closed', 'scheduled', 'open')),
  FOREIGN KEY (event_id)   REFERENCES events(id)     ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES organizers(id) ON DELETE SET NULL
);

-- 既存イベントへの backfill: mode='scheduled', app_opens_at = date_start の30分前,
-- pre_survey_closes_at = date_start の前日 23:59:59
INSERT INTO event_app_access (event_id, mode, app_opens_at, pre_survey_closes_at)
SELECT e.id, 'scheduled',
       DATE_SUB(e.date_start, INTERVAL 30 MINUTE),
       DATE_SUB(DATE_FORMAT(e.date_start, '%Y-%m-%d 23:59:59'), INTERVAL 1 DAY)
FROM events e
WHERE NOT EXISTS (SELECT 1 FROM event_app_access a WHERE a.event_id = e.id);

-- survey_questions: answer_type / question_key を追加
DROP PROCEDURE IF EXISTS add_answer_type_to_survey_questions;
DELIMITER //
CREATE PROCEDURE add_answer_type_to_survey_questions()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'survey_questions'
      AND COLUMN_NAME  = 'answer_type'
  ) THEN
    ALTER TABLE survey_questions
      ADD COLUMN answer_type VARCHAR(20) NOT NULL DEFAULT 'single',
      ADD CONSTRAINT chk_answer_type CHECK (answer_type IN ('single','multi','text'));
  END IF;
END //
DELIMITER ;
CALL add_answer_type_to_survey_questions();
DROP PROCEDURE IF EXISTS add_answer_type_to_survey_questions;

DROP PROCEDURE IF EXISTS add_question_key_to_survey_questions;
DELIMITER //
CREATE PROCEDURE add_question_key_to_survey_questions()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'survey_questions'
      AND COLUMN_NAME  = 'question_key'
  ) THEN
    ALTER TABLE survey_questions
      ADD COLUMN question_key VARCHAR(50) NULL;
  END IF;
END //
DELIMITER ;
CALL add_question_key_to_survey_questions();
DROP PROCEDURE IF EXISTS add_question_key_to_survey_questions;

-- user_survey_answers: 1参加者1回答を保証する UNIQUE (user_id, event_id)
DROP PROCEDURE IF EXISTS add_uq_user_event_to_survey_answers;
DELIMITER //
CREATE PROCEDURE add_uq_user_event_to_survey_answers()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME    = 'user_survey_answers'
      AND INDEX_NAME    = 'uq_user_event'
  ) THEN
    ALTER TABLE user_survey_answers ADD UNIQUE KEY uq_user_event (user_id, event_id);
  END IF;
END //
DELIMITER ;
CALL add_uq_user_event_to_survey_answers();
DROP PROCEDURE IF EXISTS add_uq_user_event_to_survey_answers;
