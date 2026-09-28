-- 評価フロー変更（チェックイン直後評価）に伴い、prompt_context に 'IMMEDIATE' を追加する。
-- 'NEXT_CHECKIN' は既存データのために ENUM に残すが、新規には受け付けない（server#133）。
--
-- 依存: 09（booth_ratings.prompt_context の新設）
-- 再実行: 可能（MODIFY は同じ定義を再適用しても無害）

ALTER TABLE booth_ratings
  MODIFY prompt_context ENUM('NEXT_CHECKIN','MANUAL','IMMEDIATE') NOT NULL DEFAULT 'MANUAL';
