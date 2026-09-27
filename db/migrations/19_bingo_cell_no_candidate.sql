-- 割当可能なブースが0件になったマスを終端状態にする（issue #150）。
-- docs/specs/bingo-dynamic-unlock/03-card-lifecycle/unlock.md「割当可能なブースが0件のマス」
--
-- 依存: 09（bingo_cells の is_revealed / is_achieved / source への分解）
-- 再実行: 可能（MODIFY は同じ定義の再適用が無害。ADD COLUMN は存在確認してから行う）
--
-- 1. source に 'NO_CANDIDATE' を追加する。
--    「推薦で決まったマス（RECOMMEND）」と「そもそも割り当てられなかったマス」を混ぜない。
-- 2. no_candidate_reason を追加する。
--    ALL_VISITED        = そのユーザーに未訪問の有効ブースが0件（全制覇。正常な終点）
--    INSUFFICIENT_BOOTHS = 未訪問の有効ブースは残っているが全部カードに載っている（有効ブース数 < 16）
--    判定は割当時点の「未訪問の有効ブース数」で行い、この列に凍結する。
--    あとから運営がブースを追加しても書き換えない（導出ではなく凍結値である理由）。

ALTER TABLE bingo_cells
  MODIFY source ENUM('PRESURVEY','FREE_VISIT','RECOMMEND','NO_CANDIDATE') NULL;

-- MySQL 8.0 は ADD COLUMN IF NOT EXISTS 非対応のためストアドプロシージャを使う（02 / 07 / 12 と同方式）。
DROP PROCEDURE IF EXISTS add_no_candidate_reason_to_bingo_cells;
DELIMITER //
CREATE PROCEDURE add_no_candidate_reason_to_bingo_cells()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'bingo_cells'
      AND COLUMN_NAME  = 'no_candidate_reason'
  ) THEN
    ALTER TABLE bingo_cells
      ADD COLUMN no_candidate_reason ENUM('ALL_VISITED','INSUFFICIENT_BOOTHS') NULL AFTER source;
  END IF;
END //
DELIMITER ;
CALL add_no_candidate_reason_to_bingo_cells();
DROP PROCEDURE IF EXISTS add_no_candidate_reason_to_bingo_cells;
