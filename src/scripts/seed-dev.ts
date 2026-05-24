import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { loadConfig } from '../config.js'
import { createPool } from '../db/pool.js'

/** ローカル確認用の固定 UUID（`docs/legacy/designs/database.md` の型に合わせる） */
const EVENT_ID = '20000000-0000-4000-8000-000000000001'
const CAT_TECH = '20000000-0000-4000-8000-000000000011'
const CAT_DESIGN = '20000000-0000-4000-8000-000000000012'
const BOOTH_A = '20000000-0000-4000-8000-000000000021'
const BOOTH_B = '20000000-0000-4000-8000-000000000022'
const BOOTH_C = '20000000-0000-4000-8000-000000000023'
const Q1 = '20000000-0000-4000-8000-000000000031'
const DEV_USER_ID = '20000000-0000-4000-8000-000000000041'

/** docs/tests/fixtures/dummy-login.md・frontend の DEV_API_* と同期 */
const DEV_USER_EMAIL = 'dev@example.com'
const DEV_USER_PASSWORD = 'password123'
const DEV_USER_DISPLAY_NAME = '開発用参加者'

async function ensureDevUser(pool: ReturnType<typeof createPool>) {
  const [existing] = await pool.query(
    'SELECT id FROM users WHERE event_id = ? AND email = ? LIMIT 1',
    [EVENT_ID, DEV_USER_EMAIL.toLowerCase()],
  )
  if ((existing as { id: string }[]).length) {
    console.log('Seed: dev user already exists:', DEV_USER_EMAIL)
    return
  }
  const hash = await bcrypt.hash(DEV_USER_PASSWORD, 10)
  await pool.execute(
    `INSERT INTO users (id, event_id, email, password_hash, display_name) VALUES (?,?,?,?,?)`,
    [DEV_USER_ID, EVENT_ID, DEV_USER_EMAIL.toLowerCase(), hash, DEV_USER_DISPLAY_NAME],
  )
  console.log('Seed: dev user created:', DEV_USER_EMAIL, '/', DEV_USER_PASSWORD)
}

async function main() {
  const config = loadConfig()
  const pool = createPool(config)

  const [existing] = await pool.query('SELECT id FROM events WHERE id = ? LIMIT 1', [EVENT_ID])
  if ((existing as { id: string }[]).length) {
    console.log('Seed: event already exists, skip inserts:', EVENT_ID)
    await ensureDevUser(pool)
    await pool.end()
    return
  }

  await pool.query(
    `INSERT INTO events (id, name, date_start, date_end, venue) VALUES (?,?,?,?,?)`,
    [
      EVENT_ID,
      '開発用イベント（ローカル）',
      '2026-06-01 00:00:00',
      '2026-12-31 23:59:59',
      '研究室',
    ],
  )
  await pool.query(`INSERT INTO categories (id, event_id, name) VALUES (?, ?, ?), (?, ?, ?)`, [
    CAT_TECH,
    EVENT_ID,
    'テクノロジー',
    CAT_DESIGN,
    EVENT_ID,
    'デザイン',
  ])

  await pool.query(
    `INSERT INTO booths (id, event_id, name, description, category_id, manual_code, qr_code_url, google_form_response_id)
     VALUES (?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?)`,
    [
      BOOTH_A,
      EVENT_ID,
      'AIスタートアップブース',
      '最新のAI技術を展示しています',
      CAT_TECH,
      'DEV001',
      `https://example.invalid/qr/${BOOTH_A}`,
      null,
      BOOTH_B,
      EVENT_ID,
      'デザインブース',
      'UI/UX の事例展示',
      CAT_DESIGN,
      'DEV002',
      `https://example.invalid/qr/${BOOTH_B}`,
      null,
      BOOTH_C,
      EVENT_ID,
      'ハードウェアブース',
      '組み込みデモ',
      CAT_TECH,
      'DEV003',
      `https://example.invalid/qr/${BOOTH_C}`,
      null,
    ],
  )

  await pool.query(
    `INSERT INTO booth_tags (id, booth_id, tag) VALUES (?,?,?),(?,?,?),(?,?,?)`,
    [
      randomUUID(),
      BOOTH_A,
      'AI',
      randomUUID(),
      BOOTH_A,
      'スタートアップ',
      randomUUID(),
      BOOTH_B,
      'デザイン',
    ],
  )

  await pool.query(
    `INSERT INTO survey_questions (id, event_id, question_text, options, display_order, is_required)
     VALUES (?,?,?,?,?,?)`,
    [
      Q1,
      EVENT_ID,
      '興味のある分野を選んでください',
      JSON.stringify(['AI', 'Web', 'ハードウェア', 'デザイン']),
      1,
      true,
    ],
  )

  await ensureDevUser(pool)

  console.log('Seed OK. event_id =', EVENT_ID)
  console.log('  Booths manual codes: DEV001, DEV002, DEV003')
  console.log('  Login:', DEV_USER_EMAIL, '/', DEV_USER_PASSWORD)
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
