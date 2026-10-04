/**
 * 対象: db/migrations/16_pre_survey_questions.sql, src/lib/sample-data/generate.ts
 * 仕様: docs/specs/pre-survey/02-data-model.md「本番の設問セット」
 *
 * question_key と options の value は分析・推薦側との契約である。
 * 文言を直すつもりで契約値まで書き換える事故を防ぐため、実ファイルを読んで突き合わせる。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CATEGORY_DERIVED_QUESTION_KEYS } from '../../src/lib/survey-options.js'
import { DEFAULT_PRE_SURVEY_QUESTIONS } from '../../src/lib/pre-survey/default-questions.js'

const MIGRATION = readFileSync('db/migrations/16_pre_survey_questions.sql', 'utf8')
const GENERATOR = readFileSync('src/lib/sample-data/generate.ts', 'utf8')
const DEFAULTS_SRC = readFileSync('src/lib/pre-survey/default-questions.ts', 'utf8')

/** 上から順に、期待する設問セット（必須5問 + 任意1問）。 */
const EXPECTED = [
  { key: 'interest_categories', answerType: 'multi', required: true, values: [] },
  { key: 'top_interest_category', answerType: 'single', required: true, values: [] },
  {
    key: 'age_range',
    answerType: 'single',
    required: true,
    values: ['teens', 'twenties', 'thirties', 'forties', 'fifties_plus'],
  },
  {
    key: 'occupation',
    answerType: 'single',
    required: true,
    values: ['student', 'engineer', 'designer', 'planner', 'other'],
  },
  {
    key: 'gender',
    answerType: 'single',
    required: false,
    values: ['male', 'female', 'other', 'prefer_not_to_say'],
  },
  {
    key: 'exploration_disposition',
    answerType: 'single',
    required: true,
    values: ['high', 'mid', 'low'],
  },
] as const

/** 各 INSERT 文を question_key ごとに切り出す。 */
function statementFor(key: string): string {
  const stmt = MIGRATION.split(/;\s*\n/).find((s) => s.includes(`'${key}'`))
  if (!stmt) throw new Error(`${key} の INSERT が見つかりません`)
  return stmt
}

describe('db/migrations/16_pre_survey_questions.sql', () => {
  it('6問を display_order 1〜6 の順で投入する', () => {
    const keys = EXPECTED.map((e) => e.key)
    const positions = keys.map((k) => MIGRATION.indexOf(`'${k}'`))
    expect(positions.every((p) => p >= 0)).toBe(true)
    // ファイル内の出現順が display_order の順と一致する
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    EXPECTED.forEach((e, i) => {
      expect(statementFor(e.key)).toMatch(new RegExp(`\\b${i + 1}, (TRUE|FALSE), '`))
    })
  })

  it.each(EXPECTED)('$key を正しい answer_type / 必須指定で投入する', (expected) => {
    const stmt = statementFor(expected.key)
    expect(stmt).toContain(`'${expected.answerType}', '${expected.key}'`)
    expect(stmt).toContain(expected.required ? 'TRUE,' : 'FALSE,')
  })

  it.each(EXPECTED.filter((e) => e.values.length))('$key の value が契約どおり', (expected) => {
    const stmt = statementFor(expected.key)
    const values = [...stmt.matchAll(/JSON_OBJECT\('value', '([^']+)'/g)].map((m) => m[1])
    expect(values).toEqual([...expected.values])
  })

  it('カテゴリ由来の2問は options を空配列で入れる（配信時に生成する）', () => {
    for (const key of CATEGORY_DERIVED_QUESTION_KEYS) {
      expect(statementFor(key)).toContain('JSON_ARRAY(), ')
    }
    expect([...CATEGORY_DERIVED_QUESTION_KEYS]).toEqual([
      'interest_categories',
      'top_interest_category',
    ])
  })

  it('再実行しても壊れないよう question_key で存在確認してから INSERT する（ADR 0001）', () => {
    for (const e of EXPECTED) {
      const stmt = statementFor(e.key)
      expect(stmt).toContain('WHERE NOT EXISTS')
      expect(stmt).toContain(`sq.question_key = '${e.key}'`)
    }
  })
})

describe('src/lib/pre-survey/default-questions.ts / sample-data/generate.ts', () => {
  it('本番と同じ question_key を使う', () => {
    for (const e of EXPECTED) {
      expect(DEFAULTS_SRC).toContain(`question_key: '${e.key}'`)
    }
  })

  it('日本語ラベルではなく離散コードを値に入れる', () => {
    // 旧実装が age_range 列へ '20代' を書いていた。ラベルは options の label 側にだけ現れる。
    expect(DEFAULTS_SRC).toContain("{ value: 'twenties', label: '20代' }")
    expect(GENERATOR).not.toMatch(/const AGE_RANGES = \[/)
  })

  it('サンプル生成は共有定数を参照する（設問の二重管理をしない）', () => {
    expect(GENERATOR).toContain('DEFAULT_PRE_SURVEY_QUESTIONS')
    expect(GENERATOR).not.toContain("question_key: 'age_range'")
  })

  it('custom_answers のキーを設問 UUID ではなく question_key にする', () => {
    expect(GENERATOR).toContain('interest_categories: interestCategories')
    expect(GENERATOR).toContain('top_interest_category: pick(interestCategories)')
  })
})

describe('DEFAULT_PRE_SURVEY_QUESTIONS と migration 16 の突き合わせ（issue #146）', () => {
  it('設問・順序・必須・answer_type・選択肢の value が一致する', () => {
    expect(DEFAULT_PRE_SURVEY_QUESTIONS.map((q) => q.question_key)).toEqual(EXPECTED.map((e) => e.key))
    DEFAULT_PRE_SURVEY_QUESTIONS.forEach((q, i) => {
      const e = EXPECTED[i]
      expect(q.display_order).toBe(i + 1)
      expect(q.answer_type).toBe(e.answerType)
      expect(q.is_required).toBe(e.required)
      expect(q.options.map((o) => o.value)).toEqual([...e.values])
    })
  })

  it('設問文と選択肢の label が migration と同じ', () => {
    for (const q of DEFAULT_PRE_SURVEY_QUESTIONS) {
      const stmt = statementFor(q.question_key)
      expect(stmt).toContain(`'${q.question_text}'`)
      for (const o of q.options) {
        expect(stmt).toContain(`JSON_OBJECT('value', '${o.value}'`)
        expect(stmt).toContain(`'label', '${o.label}'`)
      }
    }
  })
})
