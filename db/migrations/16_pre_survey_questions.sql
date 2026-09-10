-- 事前アンケートの本番設問セット（必須5問 + 任意1問）を既存イベントへ投入する。
-- Apply: Docker init（mysql CLI 実行）/ 既存 DB への増分適用は mysql CLI で本ファイルを直接実行する。
--        **本番（さくら）にもこのファイルだけは phpMyAdmin で 1 回流す。**
--        db/create-tables.sql は空 DB 向けの DDL 専用で、events が 1 行も無い時点で実行されるため
--        設問データを載せられない。データ投入はこのファイルが唯一の経路になる。
--
-- 要求元: ../../../event-support-recommend/docs/specs/06-pre-survey-requirements.md
-- 契約:   docs/specs/pre-survey/02-data-model.md（options は {value,label}）
--
-- 依存: 01（events / survey_questions）、pre-survey の answer_type / question_key 列
-- 再実行: **無害。** 各設問は question_key で存在確認してから INSERT する
--         （INSERT ... SELECT ... WHERE NOT EXISTS）。プロキシがエラーを 500 に潰すため
--         一意制約に頼らず SELECT で確認する方針に従う（ADR 0001）。
--         2 回目以降は 0 行挿入で、既存の設問文・選択肢は書き換えない。
--
-- 注意: question_key と options の value は分析・推薦側との契約である。**変更しない。**
--       label（表示文言）は運営の裁量で変えてよい。
--       interest_categories / top_interest_category の options は空配列で入れる。
--       配信時に categories テーブルから動的生成されるため（P-10）。

SET NAMES utf8mb4;

-- 1. 関心分野（複数選択・必須）— options は配信時に生成
INSERT INTO survey_questions
  (id, event_id, question_text, options, display_order, is_required, answer_type, question_key)
SELECT UUID(), e.id, '興味のある分野を選んでください（複数選択可）', JSON_ARRAY(), 1, TRUE, 'multi', 'interest_categories'
FROM events e
WHERE NOT EXISTS (
  SELECT 1 FROM survey_questions sq
  WHERE sq.event_id = e.id AND sq.question_key = 'interest_categories'
);

-- 2. 第1希望の分野（単一選択・必須）— options は配信時に生成
INSERT INTO survey_questions
  (id, event_id, question_text, options, display_order, is_required, answer_type, question_key)
SELECT UUID(), e.id, 'その中で、一番興味がある分野を1つ選んでください', JSON_ARRAY(), 2, TRUE, 'single', 'top_interest_category'
FROM events e
WHERE NOT EXISTS (
  SELECT 1 FROM survey_questions sq
  WHERE sq.event_id = e.id AND sq.question_key = 'top_interest_category'
);

-- 3. 年代（単一選択・必須）
INSERT INTO survey_questions
  (id, event_id, question_text, options, display_order, is_required, answer_type, question_key)
SELECT UUID(), e.id, '年代を教えてください',
  JSON_ARRAY(
    JSON_OBJECT('value', 'teens',        'label', '10代'),
    JSON_OBJECT('value', 'twenties',     'label', '20代'),
    JSON_OBJECT('value', 'thirties',     'label', '30代'),
    JSON_OBJECT('value', 'forties',      'label', '40代'),
    JSON_OBJECT('value', 'fifties_plus', 'label', '50代以上')
  ),
  3, TRUE, 'single', 'age_range'
FROM events e
WHERE NOT EXISTS (
  SELECT 1 FROM survey_questions sq
  WHERE sq.event_id = e.id AND sq.question_key = 'age_range'
);

-- 4. 職業（単一選択・必須）
INSERT INTO survey_questions
  (id, event_id, question_text, options, display_order, is_required, answer_type, question_key)
SELECT UUID(), e.id, 'ご職業を教えてください',
  JSON_ARRAY(
    JSON_OBJECT('value', 'student',  'label', '学生'),
    JSON_OBJECT('value', 'engineer', 'label', 'エンジニア'),
    JSON_OBJECT('value', 'designer', 'label', 'デザイナー'),
    JSON_OBJECT('value', 'planner',  'label', '企画・営業'),
    JSON_OBJECT('value', 'other',    'label', 'その他')
  ),
  4, TRUE, 'single', 'occupation'
FROM events e
WHERE NOT EXISTS (
  SELECT 1 FROM survey_questions sq
  WHERE sq.event_id = e.id AND sq.question_key = 'occupation'
);

-- 5. 性別（単一選択・**任意**）— 層別軸としてのみ使う。条件属性にも近傍計算にも使わない
INSERT INTO survey_questions
  (id, event_id, question_text, options, display_order, is_required, answer_type, question_key)
SELECT UUID(), e.id, '性別を教えてください（任意）',
  JSON_ARRAY(
    JSON_OBJECT('value', 'male',              'label', '男性'),
    JSON_OBJECT('value', 'female',            'label', '女性'),
    JSON_OBJECT('value', 'other',             'label', 'その他'),
    JSON_OBJECT('value', 'prefer_not_to_say', 'label', '回答しない')
  ),
  5, FALSE, 'single', 'gender'
FROM events e
WHERE NOT EXISTS (
  SELECT 1 FROM survey_questions sq
  WHERE sq.event_id = e.id AND sq.question_key = 'gender'
);

-- 6. 探索志向（単一選択・必須）— 順序尺度。セレンディピティの調整変数
INSERT INTO survey_questions
  (id, event_id, question_text, options, display_order, is_required, answer_type, question_key)
SELECT UUID(), e.id, '知らない分野のブースも見てみたいですか',
  JSON_ARRAY(
    JSON_OBJECT('value', 'high', 'label', '積極的に見たい'),
    JSON_OBJECT('value', 'mid',  'label', 'どちらともいえない'),
    JSON_OBJECT('value', 'low',  'label', '興味のある分野を中心に回りたい')
  ),
  6, TRUE, 'single', 'exploration_disposition'
FROM events e
WHERE NOT EXISTS (
  SELECT 1 FROM survey_questions sq
  WHERE sq.event_id = e.id AND sq.question_key = 'exploration_disposition'
);
