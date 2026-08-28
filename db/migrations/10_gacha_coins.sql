-- ガチャコイン（docs/specs/gacha-and-award/02-data-model/schema.md）
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
--        空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
--
-- 本番のさくら DB には migration 09 の `gacha_coin_uses`（器のみ・ユニーク制約なし）が
-- まだ適用されていない（テストデータのみ、消してよい）ため、差分適用ではなく作り直しで進める。
--
-- 冪等性: 本ファイルは 2 回実行してもエラーにならない。
--   - gacha_coin_uses  … DROP TABLE IF EXISTS してから CREATE（作り直し）
--   - gacha_settings   … CREATE TABLE IF NOT EXISTS（運営が設定した換算規則を再実行で消さない）

SET NAMES utf8mb4;

-- =============================================================================
-- 1. コイン使用台帳（追記のみ。UPDATE / DELETE しない）
--    migration 09 の器を作り直し、coin_index / idempotency_key と
--    多重消費を殺すユニークキー 2 本を張る。
-- =============================================================================
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS gacha_coin_uses;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE gacha_coin_uses (
  id              CHAR(36) PRIMARY KEY,
  event_id        CHAR(36) NOT NULL,
  user_id         CHAR(36) NOT NULL,
  coin_index      INT      NOT NULL,   -- 0 起点。そのユーザーの何枚目か
  idempotency_key CHAR(36) NOT NULL,   -- クライアント生成 UUID（G-5）
  used_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_gacha_coin (event_id, user_id, coin_index),
  UNIQUE KEY uk_gacha_idem (event_id, user_id, idempotency_key),
  INDEX idx_gacha_event_used_at (event_id, used_at),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);

-- =============================================================================
-- 2. イベントごとの換算規則（G-3）
--    行が無いイベントではコード側の既定値を使う（設定行の有無で API が 500 にならない）。
-- =============================================================================
CREATE TABLE IF NOT EXISTS gacha_settings (
  event_id       CHAR(36) PRIMARY KEY,
  is_enabled     TINYINT(1) NOT NULL DEFAULT 0,
  coins_per_line INT        NOT NULL DEFAULT 1,
  max_coins      INT        NOT NULL DEFAULT 4,
  bonus_coins    INT        NOT NULL DEFAULT 0,
  updated_at     DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
