-- =============================================================================
-- Event Support App — DB 再構築用 SQL（先生・運用側で実行）
-- =============================================================================
--
-- 【このファイルがすること】
--   既存テーブルを「データごと全削除」してから、新しいテーブル構成で
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
--   3. 末尾の確認用 SELECT で、テーブル数が 20 であることを確認する。
--      （20 を超える場合は、本スキーマ外の古いテーブルが残っている可能性あり）
--
-- 【削除 → 再作成されるテーブル（20）】
--   organizers, events, categories, booths, booth_tags, users, survey_questions,
--   user_survey_answers, bingo_cards, bingo_cells, check_ins, booth_ratings,
--   card_unlock_events, recommendation_scores, gacha_coin_uses, booth_categories,
--   exhibitor_booths, email_verification_tokens, audit_logs, event_app_access
--
-- 開発用の同一 DDL: db/migrations/01_initial_schema.sql 〜 09_*.sql（内容を同期すること）
-- 設計書: docs/designs/database.md §11、主催者自己管理機能: .sdd/02-data-model.md
-- ビンゴカード動的段階解放方式: docs/specs/bingo-dynamic-unlock/02-data-model/schema-changes.md
-- 事前アンケート／アプリ公開ゲート: docs/specs/pre-survey/02-data-model.md
-- =============================================================================

SET NAMES utf8mb4;

-- ↓ さくら等で作成済みの DB 名に変更してください（例: event_support）
USE `your_database_name`;

-- =============================================================================
-- 既存テーブルの削除（データも含めて全消去）
-- 外部キー制約があるため、参照先→参照元の逆順で DROP する
-- =============================================================================
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS gacha_coin_uses;
DROP TABLE IF EXISTS recommendation_scores;
DROP TABLE IF EXISTS card_unlock_events;
DROP TABLE IF EXISTS cell_assignment_logs;
DROP TABLE IF EXISTS recommendations;
DROP TABLE IF EXISTS bingo_cells;
DROP TABLE IF EXISTS bingo_cards;
DROP TABLE IF EXISTS event_app_access;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS email_verification_tokens;
DROP TABLE IF EXISTS exhibitor_booths;
DROP TABLE IF EXISTS booth_categories;
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
  survey_url    VARCHAR(2048),
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
  is_active               TINYINT(1)   NOT NULL DEFAULT 1,
  duration_band           ENUM('SHORT','MID','LONG')        NULL,
  knowledge_level         ENUM('NONE','HELPFUL','REQUIRED') NULL,
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
  email_verified_at DATETIME,
  onboarding_completed_at DATETIME,
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
  answer_type    VARCHAR(20) NOT NULL DEFAULT 'single',
  question_key   VARCHAR(50) NULL,
  CHECK (answer_type IN ('single','multi','text')),
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
  UNIQUE KEY uq_user_event (user_id, event_id),
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

-- bingo_cards / bingo_cells は check_ins.cell_id から参照されるため先に作成する
-- status / unlocked_at は持たない。段階はマスから導出する（D-8）
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

-- state を is_revealed / is_achieved の2軸へ分解（D-9）。source に PRESURVEY を追加、SIGNUP_BONUS は廃止
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

CREATE TABLE check_ins (
  id             CHAR(36)     PRIMARY KEY,
  user_id        CHAR(36)     NOT NULL,
  booth_id       CHAR(36)     NOT NULL,
  event_id       CHAR(36)     NOT NULL,
  checkin_method ENUM('qr', 'manual') NOT NULL,
  checked_in_at  DATETIME     NOT NULL,
  synced_at      DATETIME,
  visit_order    INT          NOT NULL DEFAULT 0,
  cell_id        CHAR(36)     NULL,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (cell_id)  REFERENCES bingo_cells(id) ON DELETE SET NULL,
  UNIQUE KEY uq_checkin_user_booth (user_id, booth_id),
  INDEX idx_checkin_event_time (event_id, checked_in_at),
  INDEX idx_checkin_event_booth (event_id, booth_id)
);

CREATE TABLE booth_ratings (
  id             CHAR(36)  PRIMARY KEY,
  user_id        CHAR(36)  NOT NULL,
  booth_id       CHAR(36)  NOT NULL,
  event_id       CHAR(36)  NOT NULL,
  checkin_id     CHAR(36)  NOT NULL,
  rating         TINYINT   NOT NULL,
  comment        TEXT,
  is_hidden      TINYINT(1) NOT NULL DEFAULT 0,
  prompt_context ENUM('NEXT_CHECKIN','MANUAL') NOT NULL DEFAULT 'MANUAL',
  scale          TINYINT   NOT NULL DEFAULT 5,
  rated_at       DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)    REFERENCES users(id)      ON DELETE CASCADE,
  FOREIGN KEY (booth_id)   REFERENCES booths(id)     ON DELETE CASCADE,
  FOREIGN KEY (event_id)   REFERENCES events(id)     ON DELETE CASCADE,
  FOREIGN KEY (checkin_id) REFERENCES check_ins(id)  ON DELETE CASCADE,
  UNIQUE KEY uq_rating_per_checkin (checkin_id)
);

-- card_unlock_events（追記専用）: 解放の履歴。UNIQUE(card_id, pair_key) が冪等性の要（D-15）
CREATE TABLE card_unlock_events (
  id                   CHAR(36)    PRIMARY KEY,
  card_id              CHAR(36)    NOT NULL,
  pair_key             VARCHAR(8)  NOT NULL,
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

-- recommendation_scores（追記専用）: 除外されていない全候補ブースを1行ずつ記録する（D-10）
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

-- gacha_coin_uses（器のみ。D-5: ビンゴはガチャコインに依存しない）
CREATE TABLE gacha_coin_uses (
  id        CHAR(36) PRIMARY KEY,
  event_id  CHAR(36) NOT NULL,
  user_id   CHAR(36) NOT NULL,
  used_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_gacha_event_user (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);

CREATE TABLE booth_categories (
  booth_id    CHAR(36) NOT NULL,
  category_id CHAR(36) NOT NULL,
  PRIMARY KEY (booth_id, category_id),
  FOREIGN KEY (booth_id)    REFERENCES booths(id)     ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE exhibitor_booths (
  user_id  CHAR(36) NOT NULL,
  booth_id CHAR(36) NOT NULL,
  PRIMARY KEY (user_id, booth_id),
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE CASCADE
);

CREATE TABLE email_verification_tokens (
  token      CHAR(64)  NOT NULL PRIMARY KEY,
  user_id    CHAR(36)  NOT NULL,
  expires_at DATETIME  NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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

-- event_app_access（新規）。行が無いイベントは mode='closed' 相当として扱う（アプリ側）
CREATE TABLE event_app_access (
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

-- 確認（一覧に20テーブルが表示されれば成功）
-- ※ さくら等の共有サーバーでは information_schema へのアクセスが権限で拒否される
--   （#1044）ため、COUNT ではなく SHOW TABLES で確認する。
SHOW TABLES;
