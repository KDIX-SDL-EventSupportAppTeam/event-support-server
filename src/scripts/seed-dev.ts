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
const EXHIBITOR_USER_ID = '20000000-0000-4000-8000-000000000042'
const ORGANIZER_ID = '20000000-0000-4000-8000-000000000051'
const ADMIN_USER_ID = '20000000-0000-4000-8000-000000000061'

/** docs/tests/fixtures/dummy-login.md・frontend の DEV_API_* と同期 */
const DEV_USER_EMAIL = 'dev@example.com'
const DEV_USER_PASSWORD = 'password123'
const DEV_USER_DISPLAY_NAME = '開発用参加者'

/** docs/tests/fixtures/dummy-login.md と同期。ブースA担当の開発用出展者。 */
const EXHIBITOR_EMAIL = 'exhibitor@example.com'
const EXHIBITOR_PASSWORD = 'password123'
const EXHIBITOR_DISPLAY_NAME = '開発用出展者'

const ORGANIZER_EMAIL = 'organizer@example.com'
const ORGANIZER_PASSWORD = 'password123'
const ORGANIZER_DISPLAY_NAME = '開発用オーガナイザー'

const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'password123'
const ADMIN_DISPLAY_NAME = '開発用運営'

async function ensureDevOrganizer(pool: ReturnType<typeof createPool>) {
  const [existing] = await pool.query(
    'SELECT id FROM organizers WHERE email = ? LIMIT 1',
    [ORGANIZER_EMAIL.toLowerCase()],
  )
  if ((existing as { id: string }[]).length) {
    console.log('Seed: organizer already exists:', ORGANIZER_EMAIL)
    return
  }
  const hash = await bcrypt.hash(ORGANIZER_PASSWORD, 10)
  await pool.execute(
    `INSERT INTO organizers (id, email, password_hash, display_name) VALUES (?,?,?,?)`,
    [ORGANIZER_ID, ORGANIZER_EMAIL.toLowerCase(), hash, ORGANIZER_DISPLAY_NAME],
  )
  console.log('Seed: organizer created:', ORGANIZER_EMAIL, '/', ORGANIZER_PASSWORD)
}

async function ensureDevAdmin(pool: ReturnType<typeof createPool>) {
  const [existing] = await pool.query(
    'SELECT id FROM users WHERE event_id = ? AND email = ? LIMIT 1',
    [EVENT_ID, ADMIN_EMAIL.toLowerCase()],
  )
  if ((existing as { id: string }[]).length) {
    console.log('Seed: admin user already exists:', ADMIN_EMAIL)
    return
  }
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10)
  await pool.execute(
    `INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)`,
    [ADMIN_USER_ID, EVENT_ID, ADMIN_EMAIL.toLowerCase(), hash, ADMIN_DISPLAY_NAME, 'manager'],
  )
  console.log('Seed: admin(manager) created:', ADMIN_EMAIL, '/', ADMIN_PASSWORD)
}

async function ensureDevUser(pool: ReturnType<typeof createPool>) {
  const [existing] = await pool.query(
    'SELECT id FROM users WHERE event_id = ? AND email = ? LIMIT 1',
    [EVENT_ID, DEV_USER_EMAIL.toLowerCase()],
  )
  const existingRows = existing as { id: string }[]
  if (existingRows.length) {
    console.log('Seed: dev user already exists:', DEV_USER_EMAIL)
    await pool.execute(
      `UPDATE users SET email_verified_at = UTC_TIMESTAMP() WHERE id = ? AND email_verified_at IS NULL`,
      [existingRows[0].id],
    )
    return
  }
  const hash = await bcrypt.hash(DEV_USER_PASSWORD, 10)
  await pool.execute(
    `INSERT INTO users (id, event_id, email, password_hash, display_name, email_verified_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP())`,
    [DEV_USER_ID, EVENT_ID, DEV_USER_EMAIL.toLowerCase(), hash, DEV_USER_DISPLAY_NAME],
  )
  console.log('Seed: dev user created:', DEV_USER_EMAIL, '/', DEV_USER_PASSWORD)
}

/** 開発用出展者を作成しブースAに紐付ける。「SELECTしてあればスキップ」流儀で冪等にする。 */
async function ensureExhibitorUser(pool: ReturnType<typeof createPool>) {
  const [existing] = await pool.query(
    'SELECT id FROM users WHERE event_id = ? AND email = ? LIMIT 1',
    [EVENT_ID, EXHIBITOR_EMAIL.toLowerCase()],
  )
  let exhibitorId = (existing as { id: string }[])[0]?.id
  if (!exhibitorId) {
    exhibitorId = EXHIBITOR_USER_ID
    const hash = await bcrypt.hash(EXHIBITOR_PASSWORD, 10)
    await pool.execute(
      `INSERT INTO users (id, event_id, email, password_hash, display_name, role) VALUES (?,?,?,?,?,?)`,
      [exhibitorId, EVENT_ID, EXHIBITOR_EMAIL.toLowerCase(), hash, EXHIBITOR_DISPLAY_NAME, 'exhibitor'],
    )
    console.log('Seed: exhibitor user created:', EXHIBITOR_EMAIL, '/', EXHIBITOR_PASSWORD)
  } else {
    console.log('Seed: exhibitor user already exists:', EXHIBITOR_EMAIL)
  }

  const [existingLink] = await pool.query(
    'SELECT 1 FROM exhibitor_booths WHERE user_id = ? AND booth_id = ? LIMIT 1',
    [exhibitorId, BOOTH_A],
  )
  if (!(existingLink as unknown[]).length) {
    await pool.execute('INSERT INTO exhibitor_booths (user_id, booth_id) VALUES (?, ?)', [
      exhibitorId,
      BOOTH_A,
    ])
    console.log('Seed: exhibitor linked to booth A')
  }
}

async function main() {
  const config = loadConfig()
  const pool = createPool(config)

  const [existing] = await pool.query('SELECT id FROM events WHERE id = ? LIMIT 1', [EVENT_ID])
  if ((existing as { id: string }[]).length) {
    console.log('Seed: event already exists, skip inserts:', EVENT_ID)
    await ensureDevOrganizer(pool)
    await ensureDevAdmin(pool)
    await ensureDevUser(pool)
    await ensureExhibitorUser(pool)
    await pool.end()
    return
  }

  // organizer を先に作成してから events.organizer_id に紐付ける
  await ensureDevOrganizer(pool)

  await pool.query(
    `INSERT INTO events (id, organizer_id, name, date_start, date_end, venue) VALUES (?,?,?,?,?,?)`,
    [
      EVENT_ID,
      ORGANIZER_ID,
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

  await ensureDevAdmin(pool)
  await ensureDevUser(pool)
  await ensureExhibitorUser(pool)

  console.log('Seed OK. event_id =', EVENT_ID)
  console.log('  Booths manual codes: DEV001, DEV002, DEV003')
  console.log('  Organizer :', ORGANIZER_EMAIL, '/', ORGANIZER_PASSWORD)
  console.log('  Admin(mgr):', ADMIN_EMAIL, '/', ADMIN_PASSWORD)
  console.log('  Participant:', DEV_USER_EMAIL, '/', DEV_USER_PASSWORD)
  console.log('  Exhibitor :', EXHIBITOR_EMAIL, '/', EXHIBITOR_PASSWORD)
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
