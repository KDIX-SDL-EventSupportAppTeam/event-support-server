-- オーガナイザー自己管理機能: organizers テーブル・events.organizer_id・audit_logs テーブル追加
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。

SET NAMES utf8mb4;

-- オーガナイザーテーブル（イベント横断アカウント）
CREATE TABLE IF NOT EXISTS organizers (
  id            CHAR(36)     PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  password_hash TEXT         NOT NULL,
  display_name  TEXT,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_organizer_email (email)
);

-- events テーブルに organizer_id を追加（既存行は NULL のまま）
-- MySQL 5.7+ は ADD COLUMN IF NOT EXISTS 非対応のため、IGNORE を使わずストアドプロシージャで安全に実行
DROP PROCEDURE IF EXISTS add_organizer_id_to_events;
DELIMITER //
CREATE PROCEDURE add_organizer_id_to_events()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'events'
      AND COLUMN_NAME  = 'organizer_id'
  ) THEN
    ALTER TABLE events
      ADD COLUMN organizer_id CHAR(36) NULL AFTER id;
  END IF;
END //
DELIMITER ;
CALL add_organizer_id_to_events();
DROP PROCEDURE IF EXISTS add_organizer_id_to_events;

-- fk_events_organizer 外部キーを追加（未存在時のみ）
DROP PROCEDURE IF EXISTS add_fk_events_organizer;
DELIMITER //
CREATE PROCEDURE add_fk_events_organizer()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA    = DATABASE()
      AND TABLE_NAME      = 'events'
      AND CONSTRAINT_NAME = 'fk_events_organizer'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT fk_events_organizer
        FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE SET NULL;
  END IF;
END //
DELIMITER ;
CALL add_fk_events_organizer();
DROP PROCEDURE IF EXISTS add_fk_events_organizer;

-- 監査ログテーブル
CREATE TABLE IF NOT EXISTS audit_logs (
  id           CHAR(36)     PRIMARY KEY,
  event_id     CHAR(36)     NOT NULL,
  actor_id     CHAR(36)     NOT NULL,
  actor_role   VARCHAR(20)  NOT NULL,
  action       VARCHAR(50)  NOT NULL,
  target_type  VARCHAR(50)  NOT NULL,
  target_id    CHAR(36),
  detail       JSON,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- users.role を 'manager' / 'viewer' に対応させる（既存の 'admin' を 'manager' に移行）
-- VARCHAR(20) は既に十分な長さのため ALTER 不要
UPDATE users SET role = 'manager' WHERE role = 'admin';
