# 依頼: 運営CRUD・ダッシュボード補完・WebSocket 実装

- **日付**: 2026-06-16
- **担当**: Cursor
- **優先度**: ②運営CRUD → ③ダッシュボード → ④WebSocket の順で実装すること

---

## 0. 前提: DB マイグレーション（最初に実行）

`users` テーブルに `role` カラムが存在しない。以下を**さくらプロキシ経由で実行**してから実装に入ること。

```bash
SAKURA_KEY="<.envのSAKURA_PROXY_KEY>"

curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: $SAKURA_KEY" \
  -d '{"sql":"ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT '\''participant'\''","params":[]}'
```

期待値: `{"rows":[],"affectedRows":0,"insertId":null}`

ローカル Docker 環境では以下を実行:

```bash
docker compose exec db mysql -u app -pappsecret event_support \
  -e "ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'participant';"
```

---

## 1. 環境変数の追加

`src/config.ts` に以下を追加する。

```typescript
// 既存 envSchema に追加
ADMIN_REGISTRATION_KEY: z.string().min(1),  // admin ユーザー登録を保護するキー
```

`AppConfig` 型にも `adminRegistrationKey: string` を追加。

`.env` / `.env.example` に `ADMIN_REGISTRATION_KEY=<ランダム文字列>` を追記。  
GCP Secret Manager にも登録し、`cloudbuild.yaml` の `--set-secrets` に追加。

---

## 2. 運営認証の修正（`src/routes/v1/auth.ts` を修正）

### 2-1. ログイン時に DB から role を読み取る

```typescript
// 修正前
const [rows] = await app.db.query(
  'SELECT id, password_hash, display_name FROM users WHERE event_id = ? AND email = ? LIMIT 1',
  [event_id, email.toLowerCase()],
)

// 修正後（role も取得）
const [rows] = await app.db.query(
  'SELECT id, password_hash, display_name, role FROM users WHERE event_id = ? AND email = ? LIMIT 1',
  [event_id, email.toLowerCase()],
)
// u.role を signAccessToken の第6引数に渡す
const token = await signAccessToken(
  app.db, app.config.jwtSecret, u.id, event_id, displayName,
  u.role === 'admin' ? 'admin' : 'participant',
)
```

### 2-2. admin 登録エンドポイントを追加

```
POST /api/v1/auth/register/admin
Header: X-Admin-Key: <ADMIN_REGISTRATION_KEY>
Body: { event_id, email, password, display_name }
```

- `req.headers['x-admin-key'] !== app.config.adminRegistrationKey` の場合 403 を返す
- users テーブルへ `role = 'admin'` で INSERT
- 発行するトークンも `role: 'admin'`

---

## 3. 共通: requireAdmin ミドルウェア（`src/plugins/auth.ts` に追加）

```typescript
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireBearerAuth(req, reply)
  if (req.jwtUser?.role !== 'admin') {
    return sendFail(reply, 403, 'FORBIDDEN', '運営権限が必要です')
  }
}
```

既存の `dashboard.ts` 内の手動チェックはこのミドルウェアに置き換える。

---

## 4. ② 運営 CRUD

### ディレクトリ構成（新規追加ファイルのみ）

```
src/routes/v1/admin/
  dashboard.ts        ← 既存（③で修正）
  categories.ts       ← NEW
  admin-booths.ts     ← NEW（参加者用 booths.ts と区別するためプレフィックス）
  survey-questions.ts ← NEW
  participants.ts     ← NEW
  events.ts           ← NEW
```

`src/app.ts` で全ファイルを register する。

### 4-1. events.ts

```
GET    /api/v1/admin/events/:event_id         イベント詳細取得
PATCH  /api/v1/admin/events/:event_id         イベント更新（name, date_start, date_end, venue）
```

認証: `requireAdmin`。  
自分の `event_id` と一致するイベントのみ操作できる（`req.jwtUser!.event_id === event_id`）。

### 4-2. categories.ts

```
GET    /api/v1/admin/events/:event_id/categories                  カテゴリ一覧
POST   /api/v1/admin/events/:event_id/categories                  カテゴリ作成
PATCH  /api/v1/admin/events/:event_id/categories/:category_id     カテゴリ更新（name）
DELETE /api/v1/admin/events/:event_id/categories/:category_id     カテゴリ削除
```

**POST リクエスト body**: `{ name: string }`  
**PATCH リクエスト body**: `{ name: string }`  
DELETE は `ON DELETE CASCADE` があるため booths.category_id は NULL になる（スキーマ済み）。

### 4-3. admin-booths.ts

```
POST   /api/v1/admin/events/:event_id/booths               ブース作成
PATCH  /api/v1/admin/events/:event_id/booths/:booth_id     ブース更新
DELETE /api/v1/admin/events/:event_id/booths/:booth_id     ブース削除
```

**POST/PATCH body**:
```typescript
{
  name: string
  description?: string
  category_id?: string | null
  manual_code: string  // 6文字以内、event内でユニーク（DB制約あり）
  tags?: string[]      // booth_tags テーブルに upsert
}
```

tags の更新は「全削除 → 再挿入」方式でシンプルに実装する。

### 4-4. survey-questions.ts

```
GET    /api/v1/admin/events/:event_id/survey-questions                        設問一覧
POST   /api/v1/admin/events/:event_id/survey-questions                        設問作成
PATCH  /api/v1/admin/events/:event_id/survey-questions/:question_id           設問更新
DELETE /api/v1/admin/events/:event_id/survey-questions/:question_id           設問削除
```

**POST/PATCH body**:
```typescript
{
  question_text: string
  options: string[]      // JSON カラム
  display_order?: number
  is_required?: boolean
}
```

### 4-5. participants.ts

```
GET    /api/v1/admin/events/:event_id/participants    参加者一覧（checkin数付き）
DELETE /api/v1/admin/events/:event_id/participants/:user_id    参加者削除
```

**GET レスポンス例**:
```json
{
  "participants": [
    {
      "id": "uuid",
      "display_name": "田中太郎",
      "email": "tanaka@example.com",
      "checkin_count": 3,
      "created_at": "2026-06-16T10:00:00"
    }
  ]
}
```

SQL:
```sql
SELECT u.id, u.display_name, u.email, u.created_at,
       COUNT(ci.id) AS checkin_count
FROM users u
LEFT JOIN check_ins ci ON ci.user_id = u.id
WHERE u.event_id = ? AND u.role = 'participant'
GROUP BY u.id
ORDER BY u.created_at DESC
```

---

## 5. ③ ダッシュボード補完（`src/routes/v1/admin/dashboard.ts` を修正）

空配列だった `booths[]` と `checkin_timeline[]` を実データで埋める。

### booths[] — ブース別チェックイン数・平均評価

```sql
SELECT b.id, b.name,
       COUNT(DISTINCT ci.id)  AS checkin_count,
       AVG(br.rating)          AS avg_rating
FROM booths b
LEFT JOIN check_ins ci  ON ci.booth_id  = b.id
LEFT JOIN booth_ratings br ON br.booth_id = b.id
WHERE b.event_id = ?
GROUP BY b.id, b.name
ORDER BY checkin_count DESC
```

**レスポンス形式** (`booths[]` の各要素):
```typescript
{
  id: string
  name: string
  checkin_count: number
  avg_rating: number | null
}
```

### checkin_timeline[] — 10分刻みのチェックイン数

```sql
SELECT
  DATE_FORMAT(
    DATE_SUB(checked_in_at, INTERVAL MOD(MINUTE(checked_in_at), 10) MINUTE),
    '%H:%i'
  ) AS time_slot,
  COUNT(*) AS count
FROM check_ins
WHERE event_id = ?
GROUP BY time_slot
ORDER BY time_slot ASC
```

**レスポンス形式** (`checkin_timeline[]` の各要素):
```typescript
{
  time_slot: string   // "10:00", "10:10", ...
  count: number
}
```

---

## 6. ④ WebSocket

### 6-1. 依存パッケージの追加

```bash
npm install socket.io @fastify/socket.io
npm install -D @types/socket.io  # なければ不要（socket.io は型同梱）
```

### 6-2. src/plugins/socket.ts（新規）

Fastify に socket.io を登録するプラグイン。

```typescript
import fp from 'fastify-plugin'
import socketIO from '@fastify/socket.io'
import { verifyAccessToken } from '../lib/jwt.js'

export const socketPlugin = fp(async (app) => {
  await app.register(socketIO, {
    cors: { origin: app.config.corsOrigin.split(',').map(s => s.trim()) },
  })

  app.io.use((socket, next) => {
    const token = socket.handshake.auth?.token ?? socket.handshake.query?.token
    if (!token) return next(new Error('Unauthorized'))
    try {
      const user = verifyAccessToken(app.config.jwtSecret, token as string)
      socket.data.user = user
      next()
    } catch {
      next(new Error('Unauthorized'))
    }
  })

  app.io.on('connection', (socket) => {
    const user = socket.data.user
    // 参加者・admin 共通ルーム
    socket.join(`event:${user.event_id}`)
    // admin のみ admin ルーム
    if (user.role === 'admin') {
      socket.join(`event:${user.event_id}:admin`)
    }
  })
})
```

### 6-3. src/index.ts に socketPlugin を追加

```typescript
import { socketPlugin } from './plugins/socket.js'
// ...
await app.register(socketPlugin)
```

### 6-4. チェックイン時に emit（`src/routes/v1/checkins.ts` を修正）

チェックイン INSERT 成功後に以下を追加:

```typescript
app.io.to(`event:${eventId}:admin`).emit('checkin:new', {
  booth_id: boothId,
  booth_name: '...', // INSERT 前に取得した名前
  user_display_name: req.jwtUser!.display_name,
  checked_in_at: checkedInAt,
})
```

### 6-5. Fastify 型拡張（`src/types/fastify.d.ts` に追加）

```typescript
import type { Server } from 'socket.io'
declare module 'fastify' {
  interface FastifyInstance {
    io: Server
  }
}
```

### 6-6. フロントエンド側（src/shared/api/socket.ts 新規）

```typescript
import { io, Socket } from 'socket.io-client'

let socket: Socket | null = null

export function connectSocket(token: string, baseUrl: string) {
  socket = io(baseUrl.replace('/api/v1', ''), {
    auth: { token },
    transports: ['websocket'],
  })
  return socket
}

export function getSocket() {
  return socket
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
}
```

admin ダッシュボードページで `connectSocket` を呼び、`checkin:new` イベントを受け取ってカウントをリアルタイム更新する。

---

## 7. `src/app.ts` に新ルートを register

```typescript
import { adminEventRoutes }          from './routes/v1/admin/events.js'
import { adminCategoryRoutes }        from './routes/v1/admin/categories.js'
import { adminBoothRoutes }           from './routes/v1/admin/admin-booths.js'
import { adminSurveyQuestionRoutes }  from './routes/v1/admin/survey-questions.js'
import { adminParticipantRoutes }     from './routes/v1/admin/participants.js'

// v1 register 内に追加
await v1.register(adminEventRoutes)
await v1.register(adminCategoryRoutes)
await v1.register(adminBoothRoutes)
await v1.register(adminSurveyQuestionRoutes)
await v1.register(adminParticipantRoutes)
```

---

## 8. フロントエンド Admin UI（event-support-frontend）

admin ルートは全て `LegacyPlaceholderPage` のため、以下を新規実装する。  
既存の `src/shared/api/v1Participant.ts` の隣に `src/shared/api/v1Admin.ts` を作成。

### 8-1. src/shared/api/v1Admin.ts

全 admin エンドポイントの axios 関数を定義する。  
`apiClient`（既存）を使い、Authorization ヘッダーは自動付与される。

主な関数：
```typescript
fetchAdminEvent(eventId)
updateAdminEvent(eventId, body)
fetchAdminCategories(eventId)
createAdminCategory(eventId, body)
updateAdminCategory(eventId, categoryId, body)
deleteAdminCategory(eventId, categoryId)
createAdminBooth(eventId, body)
updateAdminBooth(eventId, boothId, body)
deleteAdminBooth(eventId, boothId)
fetchAdminSurveyQuestions(eventId)
createAdminSurveyQuestion(eventId, body)
updateAdminSurveyQuestion(eventId, questionId, body)
deleteAdminSurveyQuestion(eventId, questionId)
fetchAdminParticipants(eventId)
deleteAdminParticipant(eventId, userId)
fetchAdminDashboard(eventId)
```

### 8-2. 新規ページ（src/features/admin/pages/ 配下）

| ページ | パス | 概要 |
|--------|------|------|
| `AdminMenuPage` | `/admin/menu` | ダッシュボード・各管理ページへのリンク一覧 |
| `DashboardPage` | `/admin/dashboard` | 参加者数・チェックイン数・ブース別グラフ（WebSocket更新） |
| `BoothManagePage` | `/admin/booths` | ブース一覧・作成・編集・削除 |
| `CategoryManagePage` | `/admin/categories` | カテゴリ一覧・作成・編集・削除 |
| `SurveyManagePage` | `/admin/survey` | アンケート設問一覧・作成・編集・削除 |
| `ParticipantsPage` | `/admin/participants` | 参加者一覧 |

### 8-3. router/index.tsx の修正

上記ページを `LegacyPlaceholderPage` から差し替える。  
admin ページには `RequireAdmin`（role==='admin' チェック）ガードを追加する。

```tsx
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const user = useAuthStore(s => s.user)
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin') return <Navigate to="/home" replace />
  return children
}
```

`useAuthStore` の `user` 型に `role: 'admin' | 'participant'` を追加。  
ログイン時に JWT から decode した role を store に保存する。

---

## 9. 実装順序

```
[1] DB マイグレーション（ALTER TABLE users ADD COLUMN role）← Cursor 外で手動実行
[2] config.ts に ADMIN_REGISTRATION_KEY を追加
[3] auth.ts 修正（login で role 読み取り、admin 登録エンドポイント追加）
[4] plugins/auth.ts に requireAdmin 追加
[5] admin/events.ts・categories.ts・admin-booths.ts・survey-questions.ts・participants.ts を実装
[6] admin/dashboard.ts を修正（booths[] / checkin_timeline[] を埋める）
[7] app.ts に新ルートを register
[8] npm run build でビルド確認
[9] plugins/socket.ts を実装・index.ts に追加・checkins.ts に emit 追加
[10] フロントエンド: v1Admin.ts → 各 admin ページ → router 修正
```

---

## 10. 動作確認手順

```bash
# admin ユーザー作成
curl -s -X POST http://localhost:3000/api/v1/auth/register/admin \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: <ADMIN_REGISTRATION_KEY>" \
  -d '{"event_id":"<EVENT_ID>","email":"admin@example.com","password":"admin1234","display_name":"運営担当"}'

# admin ログイン → token の role が "admin" であることを確認
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"event_id":"<EVENT_ID>","email":"admin@example.com","password":"admin1234"}'
# → JWT をデコードして role: "admin" を確認

# カテゴリ作成
curl -s -X POST http://localhost:3000/api/v1/admin/events/<EVENT_ID>/categories \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"テクノロジー"}'

# ブース作成
curl -s -X POST http://localhost:3000/api/v1/admin/events/<EVENT_ID>/booths \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"AIブース","description":"AI技術展示","manual_code":"AI001","category_id":"<CATEGORY_ID>"}'

# ダッシュボード確認
curl -s http://localhost:3000/api/v1/admin/events/<EVENT_ID>/dashboard \
  -H "Authorization: Bearer <TOKEN>"
```

---

## 完了

- **完了日**: 2026-07-03
- **対応 PR**: 2026-07-02 コードレビュー是正（`.sdd/2026-07-02-code-review/`）で最終確認・関連ドキュメント同期
