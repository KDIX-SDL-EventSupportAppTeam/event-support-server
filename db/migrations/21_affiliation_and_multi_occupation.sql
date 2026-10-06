-- 事前アンケートに「学内の方ですか」（affiliation）を追加し、職業（occupation）を複数回答にする。
-- Apply: 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。本番（さくら）は phpMyAdmin で 1 回流す。
--
-- 依存: 16（事前アンケートの既定設問）
-- 再実行: 無害。affiliation は question_key で存在確認してから INSERT し、
--         occupation と並び順の UPDATE は何度流しても同じ結果になる。
--
-- 契約の変更（src/lib/pre-survey/default-questions.ts と同じ内容）:
--   - occupation は answer_type = 'multi'。value に teacher（教員）・staff（大学職員）を追加。
--     user_survey_answers.occupation 列には value を昇順に並べてカンマ連結した文字列を入れる
--     （例: 'staff,teacher'）。custom_answers.occupation は配列のまま。
--     変更前の単一回答（'student' など）はそのまま有効な値として読める。
--   - affiliation は internal（学内: 在学生・教職員）/ external（学外）の単一選択・必須。

SET NAMES utf8mb4;

-- 1. 並び順をずらす（affiliation を 4 番目に入れる）
UPDATE survey_questions SET display_order = 7 WHERE question_key = 'exploration_disposition';
UPDATE survey_questions SET display_order = 6 WHERE question_key = 'gender';

-- 2. 職業を複数回答にする
UPDATE survey_questions
SET question_text = 'ご職業を教えてください（複数選択可）',
    answer_type   = 'multi',
    display_order = 5,
    options = JSON_ARRAY(
      JSON_OBJECT('value', 'student',  'label', '学生'),
      JSON_OBJECT('value', 'teacher',  'label', '教員'),
      JSON_OBJECT('value', 'staff',    'label', '大学職員'),
      JSON_OBJECT('value', 'engineer', 'label', 'エンジニア'),
      JSON_OBJECT('value', 'designer', 'label', 'デザイナー'),
      JSON_OBJECT('value', 'planner',  'label', '企画・営業'),
      JSON_OBJECT('value', 'other',    'label', 'その他')
    )
WHERE question_key = 'occupation';

-- 3. 学内外の設問を追加する
INSERT INTO survey_questions
  (id, event_id, question_text, options, display_order, is_required, answer_type, question_key)
SELECT UUID(), e.id, '学内の方ですか',
  JSON_ARRAY(
    JSON_OBJECT('value', 'internal', 'label', '学内（在学生・教職員）'),
    JSON_OBJECT('value', 'external', 'label', '学外')
  ),
  4, TRUE, 'single', 'affiliation'
FROM events e
WHERE NOT EXISTS (
  SELECT 1 FROM survey_questions sq
  WHERE sq.event_id = e.id AND sq.question_key = 'affiliation'
);
