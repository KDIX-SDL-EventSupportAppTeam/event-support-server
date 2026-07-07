-- 出展者とブースの紐付け（issue #52-1: 出展者ロール）
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
-- 空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
-- users.role は VARCHAR(20) のため 'exhibitor' 値の追加に DDL は不要（アプリ層で扱う）。
CREATE TABLE IF NOT EXISTS exhibitor_booths (
  user_id  CHAR(36) NOT NULL,
  booth_id CHAR(36) NOT NULL,
  PRIMARY KEY (user_id, booth_id),
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE CASCADE
);
