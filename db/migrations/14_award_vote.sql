-- アワード投票（issue #124）: awards / award_votes / award_settings
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
--
-- 投票できるのは「その参加者がチェックイン済みのブースだけ」。照合はサーバーで行う。
-- 1参加者 × 1賞 = 1票（付け替えは UPDATE）。開閉の既定は is_open = 0。
--
-- 依存: 01（events / users / booths）
-- 再実行: CREATE TABLE IF NOT EXISTS なので 2 回流しても無害

CREATE TABLE IF NOT EXISTS awards (
  id          CHAR(36)     PRIMARY KEY,
  event_id    CHAR(36)     NOT NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  color       VARCHAR(32)  NOT NULL DEFAULT 'pink',
  sort_order  INT          NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  UNIQUE KEY uq_award_name_event (event_id, name)
);

CREATE TABLE IF NOT EXISTS award_votes (
  id         CHAR(36) PRIMARY KEY,
  event_id   CHAR(36) NOT NULL,
  award_id   CHAR(36) NOT NULL,
  user_id    CHAR(36) NOT NULL,
  booth_id   CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (award_id) REFERENCES awards(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE CASCADE,
  UNIQUE KEY uq_vote_award_user (award_id, user_id),
  KEY idx_award_votes_tally (event_id, award_id, booth_id)
);

CREATE TABLE IF NOT EXISTS award_settings (
  event_id   CHAR(36)   PRIMARY KEY,
  is_open    TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
