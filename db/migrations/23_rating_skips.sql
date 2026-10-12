-- 評価のスキップを記録する（server#199）。booth_ratings は変えず、別テーブルに 1 チェックイン 1 行で残す
-- Apply: 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。本番（さくら）は phpMyAdmin で 1 回流す。
-- 依存: 01（users / booths / events / check_ins）
-- 再実行: 無害（IF NOT EXISTS）
CREATE TABLE IF NOT EXISTS rating_skips (
  checkin_id     CHAR(36)  PRIMARY KEY,
  user_id        CHAR(36)  NOT NULL,
  booth_id       CHAR(36)  NOT NULL,
  event_id       CHAR(36)  NOT NULL,
  prompt_context ENUM('MANUAL','IMMEDIATE') NOT NULL DEFAULT 'IMMEDIATE',
  skipped_at     DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)    REFERENCES users(id)     ON DELETE CASCADE,
  FOREIGN KEY (booth_id)   REFERENCES booths(id)    ON DELETE CASCADE,
  FOREIGN KEY (event_id)   REFERENCES events(id)    ON DELETE CASCADE,
  FOREIGN KEY (checkin_id) REFERENCES check_ins(id) ON DELETE CASCADE,
  INDEX idx_rating_skip_event (event_id)
);
