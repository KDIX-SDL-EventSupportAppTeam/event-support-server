-- 出展者の仮登録（運営がメアドとブースだけ登録し、本人が参加者登録した時点で出展者になる）
-- Apply: 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。本番（さくら）は phpMyAdmin で 1 回流す。
-- 依存: 01（events / booths）
-- 再実行: 無害（IF NOT EXISTS）
CREATE TABLE IF NOT EXISTS exhibitor_invites (
  event_id   CHAR(36)     NOT NULL,
  email      VARCHAR(255) NOT NULL,
  booth_id   CHAR(36)     NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, email, booth_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE CASCADE
);
