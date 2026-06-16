-- users テーブルに role カラムを追加（既存 DB 向け）
ALTER TABLE users
  ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'participant';
