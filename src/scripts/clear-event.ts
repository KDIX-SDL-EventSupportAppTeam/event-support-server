/**
 * イベント配下の全データを削除する（events 行と admin ユーザーは残す）。
 *
 * 使い方:
 *   npm run db:clear:event
 *   npm run db:clear:event -- --event-id=<UUID>
 */
import 'dotenv/config'
import { loadConfig } from '../config.js'
import { createPool } from '../db/pool.js'
import { clearAllEventData } from '../lib/event-data/clear-all.js'

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
    const result = await clearAllEventData(pool, eventId)
    console.log(`[clear-event] OK event_id=${eventId}`)
    console.log('  deleted:', result.deleted)
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('[clear-event] failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
