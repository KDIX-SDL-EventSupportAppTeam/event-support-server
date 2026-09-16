/**
 * 本番用最小シード。冪等。
 *
 * 投入対象:
 *   - events 1 行（環境変数で名前・期間・会場を指定）
 *   - survey_questions（環境変数 SEED_PROD_SURVEY_JSON で上書き可。未指定なら既定の必須設問）
 *
 * 投入しないもの（運用上の理由）:
 *   - 開発用ダミーユーザー（dev@example.com 等）
 *   - 開発用ダミーブース（DEV001 等）
 *   ブースは Google Forms Webhook で同期する設計のため、本番では手動 INSERT しない
 *
 * 使い方:
 *   SEED_PROD_EVENT_ID=<UUID> \
 *   SEED_PROD_EVENT_NAME="第N回 イベント名" \
 *   SEED_PROD_DATE_START="2026-06-01 09:00:00" \
 *   SEED_PROD_DATE_END="2026-06-01 18:00:00" \
 *   SEED_PROD_VENUE="会場名" \
 *   npm run db:seed:prod
 *
 * 既存の event_id が同じ行がある場合は INSERT をスキップする（冪等）。
 */
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { loadConfig } from '../config.js'
import { createPool } from '../db/pool.js'

const envSchema = z.object({
  SEED_PROD_EVENT_ID: z.string().uuid(),
  SEED_PROD_EVENT_NAME: z.string().min(1),
  SEED_PROD_DATE_START: z.string().min(1),
  SEED_PROD_DATE_END: z.string().min(1),
  SEED_PROD_VENUE: z.string().optional().default(''),
  SEED_PROD_SURVEY_JSON: z.string().optional(),
})

type SurveyQuestion = {
  question_text: string
  options: string[]
  display_order?: number
  is_required?: boolean
}

const DEFAULT_SURVEY: SurveyQuestion[] = [
  {
    question_text: '興味のある分野を選んでください',
    options: ['AI', 'Web', 'ハードウェア', 'デザイン', 'その他'],
    display_order: 1,
    is_required: true,
  },
]

function loadSeedEnv() {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('[seed-prod] Invalid env:', parsed.error.flatten().fieldErrors)
    console.error('[seed-prod] 必須環境変数の指定例:')
    console.error('  SEED_PROD_EVENT_ID=$(node -e "console.log(require(\'crypto\').randomUUID())")')
    console.error('  SEED_PROD_EVENT_NAME="本番イベント"')
    console.error('  SEED_PROD_DATE_START="2026-06-01 09:00:00"')
    console.error('  SEED_PROD_DATE_END="2026-06-01 18:00:00"')
    process.exit(1)
  }
  return parsed.data
}

function parseSurvey(raw: string | undefined): SurveyQuestion[] {
  if (!raw) return DEFAULT_SURVEY
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) throw new Error('not an array')
    return arr as SurveyQuestion[]
  } catch (e) {
    console.error('[seed-prod] SEED_PROD_SURVEY_JSON のパースに失敗:', e)
    process.exit(1)
  }
}

async function main() {
  const seedEnv = loadSeedEnv()
  const survey = parseSurvey(seedEnv.SEED_PROD_SURVEY_JSON)

  const config = loadConfig()
  const pool = createPool(config)
  try {
    const [existing] = await pool.query('SELECT id FROM events WHERE id = ? LIMIT 1', [
      seedEnv.SEED_PROD_EVENT_ID,
    ])
    if ((existing as { id: string }[]).length) {
      console.log(`[seed-prod] event already exists: ${seedEnv.SEED_PROD_EVENT_ID} (skip)`)
    } else {
      await pool.execute(
        `INSERT INTO events (id, name, date_start, date_end, venue) VALUES (?,?,?,?,?)`,
        [
          seedEnv.SEED_PROD_EVENT_ID,
          seedEnv.SEED_PROD_EVENT_NAME,
          seedEnv.SEED_PROD_DATE_START,
          seedEnv.SEED_PROD_DATE_END,
          seedEnv.SEED_PROD_VENUE || null,
        ],
      )
      console.log(`[seed-prod] inserted event: ${seedEnv.SEED_PROD_EVENT_ID}`)
    }

    // ガチャコインは有効化した状態でシードする（スキーマ既定は 0＝当日の停止用。G-8/G-11）。
    await pool.execute(
      `INSERT INTO gacha_settings (event_id, is_enabled, coins_per_line, max_coins, bonus_coins)
       VALUES (?, 1, 1, 4, 0)
       ON DUPLICATE KEY UPDATE is_enabled = 1`,
      [seedEnv.SEED_PROD_EVENT_ID],
    )
    console.log(`[seed-prod] gacha_settings enabled: ${seedEnv.SEED_PROD_EVENT_ID}`)

    for (const q of survey) {
      const [dup] = await pool.query(
        'SELECT id FROM survey_questions WHERE event_id = ? AND question_text = ? LIMIT 1',
        [seedEnv.SEED_PROD_EVENT_ID, q.question_text],
      )
      if ((dup as { id: string }[]).length) {
        console.log(`[seed-prod] survey question already exists, skip: "${q.question_text}"`)
        continue
      }
      await pool.execute(
        `INSERT INTO survey_questions (id, event_id, question_text, options, display_order, is_required)
         VALUES (?,?,?,?,?,?)`,
        [
          randomUUID(),
          seedEnv.SEED_PROD_EVENT_ID,
          q.question_text,
          JSON.stringify(q.options),
          q.display_order ?? null,
          q.is_required ?? false,
        ],
      )
      console.log(`[seed-prod] inserted survey question: "${q.question_text}"`)
    }

    console.log('[seed-prod] done.')
    console.log(`  event_id = ${seedEnv.SEED_PROD_EVENT_ID}`)
    console.log('  ※ Cloud Run / フロントで使う EVENT_ID として控えておくこと')
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[seed-prod] failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
