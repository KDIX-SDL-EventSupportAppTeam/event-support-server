-- Canonical schema: keep in sync with docs/designs/database.md §11 and db/create-tables.sql
-- Apply: Docker 初回 init / `cd server && npm run db:migrate` / mysql CLI で本ファイルを実行
-- DB は接続先で選択する（DATABASE_URL のパス、MYSQL_DATABASE、または USE 文）。USE は書かない。
-- CURRENT_TIMESTAMP（UTC_TIMESTAMP 式既定は一部環境で init 失敗するため未使用）。
-- docker-compose は --default-time-zone=+00:00 で UTC 運用。

SET NAMES utf8mb4;

CREATE TABLE events (
  id          CHAR(36)     PRIMARY KEY,
  name        TEXT         NOT NULL,
  date_start  DATETIME     NOT NULL,
  date_end    DATETIME     NOT NULL,
  venue       TEXT,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE categories (
  id        CHAR(36)  PRIMARY KEY,
  event_id  CHAR(36)  NOT NULL,
  name      TEXT      NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB;

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
) ENGINE=InnoDB;

CREATE TABLE booth_tags (
  id        CHAR(36)      PRIMARY KEY,
  booth_id  CHAR(36)      NOT NULL,
  tag       VARCHAR(255)  NOT NULL,
  FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE CASCADE,
  UNIQUE KEY uq_booth_tag (booth_id, tag)
) ENGINE=InnoDB;

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
) ENGINE=InnoDB;

CREATE TABLE survey_questions (
  id             CHAR(36)  PRIMARY KEY,
  event_id       CHAR(36)  NOT NULL,
  question_text  TEXT      NOT NULL,
  options        JSON      NOT NULL,
  display_order  INT,
  is_required    BOOLEAN   DEFAULT FALSE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB;

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
) ENGINE=InnoDB;

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
) ENGINE=InnoDB;

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
) ENGINE=InnoDB;

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
) ENGINE=InnoDB;
