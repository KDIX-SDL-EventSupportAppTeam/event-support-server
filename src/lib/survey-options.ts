/**
 * アンケート設問の選択肢・回答型の共有ロジック。
 *
 * 配信経路（`routes/v1/survey.ts`）と運営 API（`routes/v1/admin/survey-questions.ts`）の
 * 両方から使う。正規化を二重に書くと片方だけ直したときに形式が割れるため、ここに集約する。
 * 形式の正本は docs/specs/pre-survey/02-data-model.md。
 */

/** zod の enum にそのまま渡せるよう、タプルとして持つ。 */
export const ANSWER_TYPES = ['single', 'multi', 'text'] as const

export type AnswerType = (typeof ANSWER_TYPES)[number]

export type Option = { value: string; label: string }

/**
 * `options` を DB から読まず、配信時に `categories` から生成する設問キーの集合（P-10）。
 * カテゴリ由来の設問はこの集合に足すだけで両経路に反映される。
 */
export const CATEGORY_DERIVED_QUESTION_KEYS: ReadonlySet<string> = new Set([
  'interest_categories',
  'top_interest_category',
])

export function isCategoryDerivedKey(questionKey: string | null | undefined): boolean {
  return questionKey != null && CATEGORY_DERIVED_QUESTION_KEYS.has(questionKey)
}

/** 旧データ（文字列だけの配列）を `{ value, label }` 形式へ正規化する（02-data-model.md）。 */
export function normalizeOptions(raw: unknown): Option[] {
  let arr: unknown[] = []
  if (Array.isArray(raw)) arr = raw
  else if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw) as unknown
      if (Array.isArray(p)) arr = p
    } catch {
      arr = []
    }
  }
  return arr.map((o) => {
    if (o && typeof o === 'object' && 'value' in o) {
      const oo = o as { value: unknown; label?: unknown }
      const value = String(oo.value)
      const label = oo.label !== undefined ? String(oo.label) : value
      return { value, label }
    }
    const s = String(o)
    return { value: s, label: s }
  })
}
