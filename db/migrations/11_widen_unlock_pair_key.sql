-- card_unlock_events.pair_key を VARCHAR(8) → VARCHAR(16) へ広げる
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
--        空 DB への `npm run db:migrate` は db/create-tables.sql を使うため本ファイルは対象外。
--
-- 事前推薦マス（position 5）の記録は pair_key='PRESURVEY' の 9 文字を入れる
-- （docs/specs/bingo-dynamic-unlock/03-card-lifecycle/signup.md）。
-- VARCHAR(8) では入り切らず、strict mode の MySQL では ER_DATA_TOO_LONG で
-- INSERT が落ち、カード生成 API（GET /bingo/card）が 500 になっていた。
-- 非 strict mode では 'PRESURVE' に切り詰められて保存され、カード取得時の
-- `WHERE pair_key <> 'PRESURVEY'` を素通りしてしまう（事前推薦が解放演出として再生される）。
--
-- 通常の pair_key は `5-9` 形式で最長 5 文字。16 は 'PRESURVEY' と将来の予約語に十分な幅。
--
-- 冪等性: 2 回実行してもエラーにならない（同じ型への MODIFY は無害）。

SET NAMES utf8mb4;

ALTER TABLE card_unlock_events
  MODIFY COLUMN pair_key VARCHAR(16) NOT NULL;
