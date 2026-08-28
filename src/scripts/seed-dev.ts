import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { loadConfig } from '../config.js'
import { createPool } from '../db/pool.js'

/** ローカル確認用の固定 UUID（`docs/legacy/designs/database.md` の型に合わせる） */
const EVENT_ID = '20000000-0000-4000-8000-000000000001'
const seedId = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const CAT_TECH = seedId(11)
const CAT_DESIGN = seedId(12)
const CAT_FOOD = seedId(13)
const CAT_SCIENCE = seedId(14)

const CATEGORY_SEEDS: { id: string; name: string }[] = [
  { id: CAT_TECH, name: 'テクノロジー' },
  { id: CAT_DESIGN, name: 'デザイン' },
  { id: CAT_FOOD, name: 'フード' },
  { id: CAT_SCIENCE, name: 'サイエンス' },
]

/**
 * ビンゴカードは16マスなので、カードを最後まで埋めるには最低16ブースが要る。
 * さらに解放時の推薦・フォールバックは「カード掲載済み・訪問済み・中止」を候補から除くため、
 * 16 ちょうどだと最後の解放で候補切れ（E7: booth_id=NULL の空マス）になりやすい。
 * 余裕を持たせて20件用意する。manual_code は DEV001〜DEV020。
 */
const BOOTH_SEEDS: { id: string; name: string; description: string; categoryId: string }[] = [
  { id: seedId(21), name: 'AIスタートアップブース', description: '最新のAI技術を展示しています', categoryId: CAT_TECH },
  { id: seedId(22), name: 'デザインブース', description: 'UI/UX の事例展示', categoryId: CAT_DESIGN },
  { id: seedId(23), name: 'ハードウェアブース', description: '組み込みデモ', categoryId: CAT_TECH },
  { id: seedId(24), name: 'Webフロントエンド研究会', description: 'React と WebGL の実験展示', categoryId: CAT_TECH },
  { id: seedId(25), name: 'ロボティクス実験室', description: '自律移動ロボットの実演', categoryId: CAT_TECH },
  { id: seedId(26), name: 'セキュリティ診断体験', description: '脆弱性診断のハンズオン', categoryId: CAT_TECH },
  { id: seedId(27), name: 'データ可視化スタジオ', description: '統計データをインタラクティブに', categoryId: CAT_TECH },
  { id: seedId(28), name: 'グラフィックデザイン工房', description: 'ポスター制作の裏側', categoryId: CAT_DESIGN },
  { id: seedId(29), name: 'プロダクトデザイン展', description: '試作品の変遷を並べています', categoryId: CAT_DESIGN },
  { id: seedId(30), name: '写真・映像ラボ', description: '短編作品の上映', categoryId: CAT_DESIGN },
  { id: seedId(31), name: '建築模型コーナー', description: '学生設計課題の模型展示', categoryId: CAT_DESIGN },
  { id: seedId(32), name: '3Dプリント体験', description: 'その場で小物を出力します', categoryId: CAT_DESIGN },
  { id: seedId(33), name: 'キッチンカー（軽食）', description: 'ホットサンドとスープ', categoryId: CAT_FOOD },
  { id: seedId(34), name: 'コーヒースタンド', description: '自家焙煎のドリップコーヒー', categoryId: CAT_FOOD },
  { id: seedId(35), name: 'スイーツ研究会', description: '焼き菓子の販売と試食', categoryId: CAT_FOOD },
  { id: seedId(36), name: '地域産品マルシェ', description: '近隣農家の野菜と加工品', categoryId: CAT_FOOD },
  { id: seedId(37), name: '化学実験ショー', description: '発光と結晶のデモ', categoryId: CAT_SCIENCE },
  { id: seedId(38), name: '天文観測ブース', description: '望遠鏡と太陽投影', categoryId: CAT_SCIENCE },
  { id: seedId(39), name: '生物多様性コーナー', description: '標本と顕微鏡観察', categoryId: CAT_SCIENCE },
  { id: seedId(40), name: '物理おもちゃ工作', description: '力学のふしぎを手で確かめる', categoryId: CAT_SCIENCE },
]

const BOOTH_A = BOOTH_SEEDS[0]!.id
const BOOTH_B = BOOTH_SEEDS[1]!.id
const BOOTH_C = BOOTH_SEEDS[2]!.id
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

/**
 * アプリ公開ゲート（event_app_access）を開発用に開けておく。
 * 行が無いイベントは mode='closed' 相当として扱われ、参加者が /home に入れないため
 * （docs/specs/pre-survey/02-data-model.md）。ローカルでは常に開放しておく。
 * pre_survey_closes_at は NULL のままにして事前アンケートも開いた状態にする。
 */
async function ensureDevAppAccess(pool: ReturnType<typeof createPool>) {
  await pool.query(
    `INSERT INTO event_app_access (event_id, mode, app_opens_at, app_closes_at, pre_survey_closes_at)
     VALUES (?, 'open', NULL, NULL, NULL)
     ON DUPLICATE KEY UPDATE mode = VALUES(mode)`,
    [EVENT_ID],
  )
  console.log('Seed: event_app_access set to open:', EVENT_ID)
}

/**
 * ガチャコイン設定（gacha_settings）を有効化しておく。
 * スキーマ既定は is_enabled=0（当日ガチャを止められるようにするため。G-8）だが、
 * ローカル・シード時は常に 1 にしておき、すぐ使用まで試せるようにする。
 * 換算は確定値（1枚/ライン・上限4・ボーナス0。G-11）。
 */
async function ensureDevGachaSettings(pool: ReturnType<typeof createPool>) {
  await pool.query(
    `INSERT INTO gacha_settings (event_id, is_enabled, coins_per_line, max_coins, bonus_coins)
     VALUES (?, 1, 1, 4, 0)
     ON DUPLICATE KEY UPDATE is_enabled = 1`,
    [EVENT_ID],
  )
  console.log('Seed: gacha_settings enabled:', EVENT_ID)
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
    await ensureDevAppAccess(pool)
    await ensureDevGachaSettings(pool)
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
  await pool.query(
    `INSERT INTO categories (id, event_id, name) VALUES ${CATEGORY_SEEDS.map(() => '(?,?,?)').join(',')}`,
    CATEGORY_SEEDS.flatMap((c) => [c.id, EVENT_ID, c.name]),
  )

  await pool.query(
    `INSERT INTO booths (id, event_id, name, description, category_id, manual_code, qr_code_url, google_form_response_id)
     VALUES ${BOOTH_SEEDS.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`,
    BOOTH_SEEDS.flatMap((b, i) => [
      b.id,
      EVENT_ID,
      b.name,
      b.description,
      b.categoryId,
      `DEV${String(i + 1).padStart(3, '0')}`,
      `https://example.invalid/qr/${b.id}`,
      null,
    ]),
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
    // question_key='interest_categories' の設問だけは options を DB から読まず
    // categories テーブルから動的生成する（docs/specs/pre-survey/06-api.md）。
    // この設問が無いと custom_answers.interest_categories が入らず、
    // ビンゴの事前推薦マス（position 5）が永久に空のままになる。
    `INSERT INTO survey_questions (id, event_id, question_text, options, display_order, is_required, answer_type, question_key)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      Q1,
      EVENT_ID,
      '興味のある分野を選んでください',
      JSON.stringify([]),
      1,
      true,
      'multi',
      'interest_categories',
    ],
  )

  await ensureDevAdmin(pool)
  await ensureDevUser(pool)
  await ensureExhibitorUser(pool)
  await ensureDevAppAccess(pool)
  await ensureDevGachaSettings(pool)

  console.log('Seed OK. event_id =', EVENT_ID)
  console.log(`  Booths: ${BOOTH_SEEDS.length} 件 / manual codes: DEV001〜DEV${String(BOOTH_SEEDS.length).padStart(3, '0')}`)
  console.log(`  Categories: ${CATEGORY_SEEDS.map((c) => c.name).join(', ')}`)
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
