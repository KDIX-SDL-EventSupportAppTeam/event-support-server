-- ブースとカテゴリの多対多（サンプルデータ・将来の複数カテゴリ対応）
CREATE TABLE IF NOT EXISTS booth_categories (
  booth_id    CHAR(36) NOT NULL,
  category_id CHAR(36) NOT NULL,
  PRIMARY KEY (booth_id, category_id),
  FOREIGN KEY (booth_id)    REFERENCES booths(id)     ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);
