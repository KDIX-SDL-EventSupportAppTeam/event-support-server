/**
 * [SAMPLE] プレフィックス付きデータのみ削除する（本番データは触らない）。
 *
 * 使い方:
 *   npm run db:clear:sample
 *   npm run db:clear:sample -- --event-id=<UUID>
 */
import 'dotenv/config'
import { loadConfig } from '../config.js'
import { createPool } from '../db/pool.js'
import { clearSampleData } from '../lib/sample-data/clear.js'

const DEFAULT_EVENT_ID = '20000000-0000-4000-8000-000000000001'

function parseEventId(): string {
  const fromArg = process.argv.slice(2).find((a) => a.startsWith('--event-id='))
  if (fromArg) return fromArg.slice('--event-id='.length)
  return process.env.SAMPLE_EVENT_ID ?? DEFAULT_EVENT_ID
}

async function main() {
  const eventId = parseEventId()
  const pool = createPool(loadConfig())
  try {
    const result = await clearSampleData(pool, eventId)
    console.log(`[clear-sample] OK event_id=${eventId}`)
    console.log('  deleted:', result.deleted)
    console.log(`  割り当てを外したマス: ${result.cleared_cells}`)
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[clear-sample] failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
