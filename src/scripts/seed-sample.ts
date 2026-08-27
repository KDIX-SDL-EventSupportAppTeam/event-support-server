/**
 * 分析・運営画面確認用の [SAMPLE] データを生成する。
 *
 * 使い方:
 *   npm run db:seed:sample
 *   npm run db:seed:sample -- --event-id=<UUID>
 *   npm run db:seed:sample -- --event-id=<UUID> --force
 *
 * 環境変数: SAMPLE_EVENT_ID（--event-id 未指定時）
 * 既定 event_id: seed-dev と同じ 20000000-0000-4000-8000-000000000001
 */
import 'dotenv/config'
import { loadConfig } from '../config.js'
import { createPool } from '../db/pool.js'
import { SAMPLE_PREFIX, SAMPLE_USER_PASSWORD } from '../lib/sample-data/constants.js'
import { generateSampleData } from '../lib/sample-data/generate.js'

const DEFAULT_EVENT_ID = '20000000-0000-4000-8000-000000000001'

function parseArgs() {
  const args = process.argv.slice(2)
  let eventId = process.env.SAMPLE_EVENT_ID ?? DEFAULT_EVENT_ID
  let force = false
  for (const arg of args) {
    if (arg.startsWith('--event-id=')) eventId = arg.slice('--event-id='.length)
    if (arg === '--force') force = true
  }
  return { eventId, force }
}

async function main() {
  const { eventId, force } = parseArgs()
  const pool = createPool(loadConfig())
  try {
    const result = await generateSampleData(pool, eventId, { force })
    console.log(`[seed-sample] OK event_id=${eventId}`)
    console.log(`  プレフィックス: ${SAMPLE_PREFIX}`)
    console.log(`  カテゴリ: ${result.categories}（各ブース 2〜4 カテゴリ）`)
    console.log(`  ブース: ${result.booths}`)
    console.log(`  参加者: ${result.participants}（password: ${SAMPLE_USER_PASSWORD}）`)
    console.log(`  チェックイン: ${result.checkins}`)
    console.log(`  評価: ${result.ratings}`)
    console.log(`  アンケート回答: ${result.survey_answers}`)
    console.log(`  アンケート設問: ${result.survey_questions}`)
    console.log(`  参加者メール例: sample-001@sample.local`)
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[seed-sample] failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
