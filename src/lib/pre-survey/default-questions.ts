import { randomUUID } from 'node:crypto'
import type { DbClient } from '../../db/client.js'
import { insertAuditLog } from '../audit.js'

/**
 * 事前アンケートの既定設問セット（必須6問 + 任意1問）。issue #146。
 *
 * `db/migrations/16_pre_survey_questions.sql` に 21（学内外の設問追加・職業の複数回答化）を重ねた内容。
 * **`question_key` と `options` の `value` は分析・推薦側との契約である。変更しない。**
 * `interest_categories` / `top_interest_category` の `options` は空配列
 * （配信時に `categories` から生成される。P-10）。
 *
 * 参照元: イベント作成（`POST /organizer/events`）、運営の投入し直し
 * （`POST /admin/events/:event_id/survey-questions/defaults`）、サンプルデータ生成。
 */
export type DefaultSurveyQuestion = {
  question_key: string
  display_order: number
  question_text: string
  answer_type: 'single' | 'multi' | 'text'
  is_required: boolean
  options: { value: string; label: string }[]
}

export const DEFAULT_PRE_SURVEY_QUESTIONS: readonly DefaultSurveyQuestion[] = [
  {
    question_key: 'interest_categories',
    display_order: 1,
    question_text: '興味のある分野を選んでください（複数選択可）',
    answer_type: 'multi',
    is_required: true,
    options: [], // 配信時に categories から生成する（P-10）
  },
  {
    question_key: 'top_interest_category',
    display_order: 2,
    question_text: 'その中で、一番興味がある分野を1つ選んでください',
    answer_type: 'single',
    is_required: true,
    options: [], // 同上
  },
  {
    question_key: 'age_range',
    display_order: 3,
    question_text: '年代を教えてください',
    answer_type: 'single',
    is_required: true,
    options: [
      { value: 'teens', label: '10代' },
      { value: 'twenties', label: '20代' },
      { value: 'thirties', label: '30代' },
      { value: 'forties', label: '40代' },
      { value: 'fifties_plus', label: '50代以上' },
    ],
  },
  {
    // 学内関係者かどうか（プロトフェスで学内外の来場者を区別する）
    question_key: 'affiliation',
    display_order: 4,
    question_text: '学内の方ですか',
    answer_type: 'single',
    is_required: true,
    options: [
      { value: 'internal', label: '学内（在学生・教職員）' },
      { value: 'external', label: '学外' },
    ],
  },
  {
    // 複数回答。専用列 occupation には value を昇順に並べてカンマ連結した文字列を保存する
    question_key: 'occupation',
    display_order: 5,
    question_text: 'ご職業を教えてください（複数選択可）',
    answer_type: 'multi',
    is_required: true,
    options: [
      { value: 'student', label: '学生' },
      { value: 'teacher', label: '教員' },
      { value: 'staff', label: '大学職員' },
      { value: 'engineer', label: 'エンジニア' },
      { value: 'designer', label: 'デザイナー' },
      { value: 'planner', label: '企画・営業' },
      { value: 'other', label: 'その他' },
    ],
  },
  {
    question_key: 'gender',
    display_order: 6,
    question_text: '性別を教えてください（任意）',
    answer_type: 'single',
    is_required: false,
    options: [
      { value: 'male', label: '男性' },
      { value: 'female', label: '女性' },
      { value: 'other', label: 'その他' },
      { value: 'prefer_not_to_say', label: '回答しない' },
    ],
  },
  {
    question_key: 'exploration_disposition',
    display_order: 7,
    question_text: '知らない分野のブースも見てみたいですか',
    answer_type: 'single',
    is_required: true,
    options: [
      { value: 'high', label: '積極的に見たい' },
      { value: 'mid', label: 'どちらともいえない' },
      { value: 'low', label: '興味のある分野を中心に回りたい' },
    ],
  },
]

/**
 * 既定設問のうち、イベントに無いものだけを投入する（冪等）。
 *
 * - 存在確認は `question_key` で行う。INSERT の前に SELECT する（さくらプロキシは重複キーを 500 に潰す。ADR 0001）
 * - **既にある設問の文言・選択肢は書き換えない**（運営が直した文言を守る）
 * - 投入した設問ごとに監査ログ `survey_question.create` を残す
 *
 * @returns 今回投入した question_key の一覧
 */
export async function ensureDefaultSurveyQuestions(
  db: DbClient,
  eventId: string,
  actor: { id: string; role: string },
): Promise<string[]> {
  const [existingRows] = await db.query(
    'SELECT question_key FROM survey_questions WHERE event_id = ? AND question_key IS NOT NULL',
    [eventId],
  )
  const existing = new Set((existingRows as { question_key: string }[]).map((r) => r.question_key))
  const inserted: string[] = []
  for (const q of DEFAULT_PRE_SURVEY_QUESTIONS) {
    if (existing.has(q.question_key)) continue
    const id = randomUUID()
    await db.execute(
      `INSERT INTO survey_questions
         (id, event_id, question_text, options, display_order, is_required, question_key, answer_type)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        id,
        eventId,
        q.question_text,
        JSON.stringify(q.options),
        q.display_order,
        q.is_required ? 1 : 0,
        q.question_key,
        q.answer_type,
      ],
    )
    await insertAuditLog(db, {
      eventId,
      actorId: actor.id,
      actorRole: actor.role,
      action: 'survey_question.create',
      targetType: 'survey_question',
      targetId: id,
      detail: { question_text: q.question_text, question_key: q.question_key, source: 'default' },
    })
    inserted.push(q.question_key)
  }
  return inserted
}
