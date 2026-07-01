-- =============================================================================
-- Event Support App — DB 再構築用 SQL（先生・運用側で実行）
-- =============================================================================
--
-- 【このファイルがすること】
--   既存の13テーブルを「データごと全削除」してから、新しいテーブル構成で
--   作り直します。実行すると **中に入っているデータはすべて消えます**。
--   バックアップが必要な場合は、実行前に必ずダンプを取得してください。
--
-- 【前提】
--   - MySQL 8.0.16 以上（InnoDB）。CHECK 制約を使用しています。
--   - 対象 DB は、空でも・既にテーブルやデータが入っていても構いません。
--     （既存テーブルは冒頭の DROP セクションで削除するため、上書き実行できます。）
--
-- 【実行手順】
--   1. 下の「USE」の行で、実際のデータベース名に書き換える。
--      （phpMyAdmin 等で対象 DB を選択済みの場合は、USE 行を削除しても構いません。）
--   2. このファイル全文を SQL 実行画面に貼り付けて実行する。
--   3. 末尾の確認用 SELECT で、テーブル数が 13 であることを確認する。
--      （13 を超える場合は、本スキーマ外の古いテーブルが残っている可能性あり）
--
-- 【削除 → 再作成されるテーブル（13）】
--   events, categories, booths, booth_tags, users, survey_questions,
--   user_survey_answers, check_ins, booth_ratings, recommendations,
--   booth_categories, organizers, audit_logs
--
-- 開発用の同一 DDL: db/migrations/01_initial_schema.sql + 02_*.sql + 03_*.sql（内容を同期すること）
-- 設計書: docs/designs/database.md §11、主催者自己管理機能: .sdd/02-data-model.md
-- =============================================================================

SET NAMES utf8mb4;

-- ↓ さくら等で作成済みの DB 名に変更してください（例: event_support）
USE `your_database_name`;

-- =============================================================================
-- 既存テーブルの削除（データも含めて全消去）
-- 外部キー制約があるため、参照先→参照元の逆順で DROP する
-- =============================================================================
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS booth_categories;
DROP TABLE IF EXISTS recommendations;
DROP TABLE IF EXISTS booth_ratings;
DROP TABLE IF EXISTS check_ins;
DROP TABLE IF EXISTS user_survey_answers;
DROP TABLE IF EXISTS survey_questions;
DROP TABLE IF EXISTS booth_tags;
DROP TABLE IF EXISTS booths;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS organizers;
SET FOREIGN_KEY_CHECKS = 1;
-- =============================================================================

-- organizers は events から参照されるため先に作成する
CREATE TABLE organizers (
  id            CHAR(36)     PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  password_hash TEXT         NOT NULL,
  display_name  TEXT,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_organizer_email (email)
);

CREATE TABLE events (
  id            CHAR(36)     PRIMARY KEY,
  organizer_id  CHAR(36),
  name          TEXT         NOT NULL,
  date_start    DATETIME     NOT NULL,
  date_end      DATETIME     NOT NULL,
  venue         TEXT,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE SET NULL
);

CREATE TABLE categories (
  id        CHAR(36)  PRIMARY KEY,
  event_id  CHAR(36)  NOT NULL,
  name      TEXT      NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE booths (
  id                      CHAR(36)     PRIMARY KEY,
  event_id                CHAR(36)     NOT NULL,
  name                    TEXT         NOT NULL,
  description             TEXT,
  category_id             CHAR(36),
  manual_code             VARCHAR(6)   NOT NULL,
  qr_code_url             TEXT,
  google_form_response_id TEXT,
  created_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id)    REFERENCES events(id)     ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  UNIQUE KEY uq_manual_code_event (event_id, manual_code)
);

CREATE TABLE booth_tags (
  id        CHAR(36)      PRIMARY KEY,
  booth_id  CHAR(36)      NOT NULL,
  tag       VARCHAR(255)  NOT NULL,
  FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE CASCADE,
  UNIQUE KEY uq_booth_tag (booth_id, tag)
);

CREATE TABLE users (
  id            CHAR(36)  PRIMARY KEY,
  event_id      CHAR(36)  NOT NULL,
  email         VARCHAR(255) NOT NULL,
  password_hash TEXT,
  google_id     TEXT,
  display_name  TEXT,
  role          VARCHAR(20) NOT NULL DEFAULT 'participant',
  created_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_email_event (email, event_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE survey_questions (
  id             CHAR(36)  PRIMARY KEY,
  event_id       CHAR(36)  NOT NULL,
  question_text  TEXT      NOT NULL,
  options        JSON      NOT NULL,
  display_order  INT,
  is_required    BOOLEAN   DEFAULT FALSE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE user_survey_answers (
  id              CHAR(36)  PRIMARY KEY,
  user_id         CHAR(36)  NOT NULL,
  event_id        CHAR(36)  NOT NULL,
  age_range       VARCHAR(50),
  occupation      VARCHAR(100),
  industry        VARCHAR(100),
  custom_answers  JSON,
  created_at      DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE check_ins (
  id             CHAR(36)     PRIMARY KEY,
  user_id        CHAR(36)     NOT NULL,
  booth_id       CHAR(36)     NOT NULL,
  event_id       CHAR(36)     NOT NULL,
  checkin_method ENUM('qr', 'manual') NOT NULL,
  checked_in_at  DATETIME     NOT NULL,
  synced_at      DATETIME,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  UNIQUE KEY uq_checkin_user_booth (user_id, booth_id)
);

CREATE TABLE booth_ratings (
  id          CHAR(36)  PRIMARY KEY,
  user_id     CHAR(36)  NOT NULL,
  booth_id    CHAR(36)  NOT NULL,
  event_id    CHAR(36)  NOT NULL,
  checkin_id  CHAR(36)  NOT NULL,
  rating      TINYINT   NOT NULL CHECK (rating BETWEEN 1 AND 5),
  rated_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)    REFERENCES users(id)      ON DELETE CASCADE,
  FOREIGN KEY (booth_id)   REFERENCES booths(id)     ON DELETE CASCADE,
  FOREIGN KEY (event_id)   REFERENCES events(id)     ON DELETE CASCADE,
  FOREIGN KEY (checkin_id) REFERENCES check_ins(id)  ON DELETE CASCADE,
  UNIQUE KEY uq_rating_per_checkin (checkin_id)
);

CREATE TABLE recommendations (
  id                 CHAR(36)  PRIMARY KEY,
  user_id            CHAR(36)  NOT NULL,
  event_id           CHAR(36)  NOT NULL,
  offered_booth_ids  JSON      NOT NULL,
  selected_booth_id  CHAR(36),
  rejected_booth_ids JSON,
  algorithm          VARCHAR(50) NOT NULL,
  created_at         DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)           REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (event_id)          REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (selected_booth_id) REFERENCES booths(id) ON DELETE SET NULL
);

CREATE TABLE booth_categories (
  booth_id    CHAR(36) NOT NULL,
  category_id CHAR(36) NOT NULL,
  PRIMARY KEY (booth_id, category_id),
  FOREIGN KEY (booth_id)    REFERENCES booths(id)     ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

-- 監査ログ（誰が・いつ・何をしたかの操作証跡）
-- actor_id は users(id) への外部キーを張らない（アカウント削除後も履歴を残すため）
CREATE TABLE audit_logs (
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

-- 確認（結果が 13 なら成功）
SELECT COUNT(*) AS table_count
FROM information_schema.tables
WHERE table_schema = DATABASE();
