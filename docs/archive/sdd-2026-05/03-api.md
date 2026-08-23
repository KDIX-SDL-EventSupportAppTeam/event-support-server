# 03. API 定義

新規ルートは `src/routes/v1/organizer/` 配下に集約する（単一ドメイン＝主催者）。既存 `routes/v1/*` は触らない。`admin/` 配下は preHandler の差し替えのみ行う（3.5 参照）。レスポンスは既存どおり `sendOk` / `sendFail`、入力は zod で検証する。

ベースパス：`/api/v1/organizer`

## 3.1 主催者認証

### POST `/api/v1/organizer/auth/register`
主催者アカウントを新規発行。**認証モードは切り替え可能**（[04-auth.md](./04-auth.md) 4.6）。今回実装する `invite` モードでは登録キーで保護する。

- **保護（invite モード）**：ヘッダ `X-Organizer-Registration-Key` が `ORGANIZER_REGISTRATION_KEY` と一致すること。不一致は 403。
- **保護（open モード・将来）**：キー不要。メール認証＋レート制限。分岐は `assertCanRegisterOrganizer` ヘルパに集約する。
- **Body**：`{ email, password, display_name }`
- **処理**：email 全体一意チェック → bcrypt ハッシュ → `organizers` INSERT
- **返却**：`{ token, organizer: { id, email, display_name } }`（token は主催者 JWT）
- **エラー**：409（email 既存）、400（バリデーション）、403（キー不一致）

### POST `/api/v1/organizer/auth/login`
- **Body**：`{ email, password }`
- **返却**：`{ token, organizer: { id, email, display_name } }`
- **エラー**：401（認証失敗）

> 主催者 JWT の payload は `{ sub: organizer_id, scope: 'organizer', display_name }`。**`event_id` を含めない**ことが運営/参加者 JWT との識別子。詳細は [04-auth.md](./04-auth.md)。

## 3.2 イベント管理（要・主催者 JWT）

全エンドポイントで preHandler `requireOrganizer` を通す。返却対象は**ログイン主催者が所有する（`organizer_id` 一致）イベントのみ**。

### POST `/api/v1/organizer/events` — 作成 ＋ URL 発行【中核】
- **Body**
  ```jsonc
  {
    "name": "string",
    "date_start": "ISO8601",
    "date_end": "ISO8601",
    "venue": "string?",
    "initial_manager": {
      "email": "string",
      "password": "string",
      "display_name": "string?"
    }
  }
  ```
- **処理（トランザクション）**
  1. `events` INSERT（`id`=UUID 生成、`organizer_id`=JWT の主催者）
  2. `users` INSERT（`event_id`=作成した event、**`role='manager'`**、`initial_manager.*`、bcrypt ハッシュ）
  3. `audit_logs` INSERT（`action='staff.invite'`、`detail={role:'manager'}`、actor_id=初期 manager の id）
  4. URL を組み立てる（`FRONTEND_BASE_URL` ＋ 固定パス）
- **返却**
  ```jsonc
  {
    "event": { "id", "name", "date_start", "date_end", "venue" },
    "initial_manager": { "id", "email" },
    "urls": {
      "participant": "<FRONTEND_BASE_URL>/join/<event_id>",
      "admin":       "<FRONTEND_BASE_URL>/admin/login?event=<event_id>"
    }
  }
  ```
- **エラー**：400（日程逆転・必須欠落）、409（同一イベント内 email 既存）

### GET `/api/v1/organizer/events` — 一覧（Phase 2）
- 自分の `organizer_id` のイベント配列。`urls` も同梱すると再生成不要。

### GET `/api/v1/organizer/events/:event_id` — 詳細（Phase 2）
- 所有チェック必須。他主催者のイベントは 404（存在秘匿）。

### PATCH `/api/v1/organizer/events/:event_id` — 概要編集（Phase 2）
- **Body**：`{ name?, date_start?, date_end?, venue? }`（部分更新）
- `events` 行の概要のみ。スタッフ・ブース等には触れない。

### DELETE `/api/v1/organizer/events/:event_id` — 削除（Phase 2）
- 所有チェック必須。配下（users/booths/check_ins…）は `ON DELETE CASCADE` で全削除。UI 側に強く警告（不可逆）。

## 3.3 スタッフ管理（要・主催者 JWT）

主催者がイベントのスタッフ（`manager` / `viewer`）を招待・管理する。

### POST `/api/v1/organizer/events/:event_id/staff` — スタッフ招待
- **保護**：主催者 JWT ＋ 所有チェック
- **Body**：`{ email, password, display_name?, role: 'manager' | 'viewer' }`
- **処理（トランザクション）**
  1. `users` INSERT（`event_id`, email, bcrypt(password), `role`）
  2. `audit_logs` INSERT（`action='staff.invite'`, `detail={ email, role }`）
- **返却**：`{ staff: { id, email, display_name, role } }`
- **エラー**：409（同一イベント内 email 既存）、400
- **URL 共有**：レスポンス内で `urls.admin` を再返却すると招待後すぐにコピペ共有できる（任意実装）

### GET `/api/v1/organizer/events/:event_id/staff` — スタッフ一覧（Phase 2）
- 所有チェック必須。`role='participant'` は除外し運営スタッフのみ返す。

### PATCH `/api/v1/organizer/events/:event_id/staff/:user_id` — ロール変更（Phase 2）
- **Body**：`{ role: 'manager' | 'viewer' }`
- **制約**：対象が最後の `manager` への降格は 400 で禁止（`manager` 0 人防止）
- **処理（トランザクション）**：`users.role` UPDATE ＋ `audit_logs` INSERT（`action='staff.role_change'`, `detail={ before, after }`）

### DELETE `/api/v1/organizer/events/:event_id/staff/:user_id` — スタッフ削除（Phase 2）
- 最後の `manager` の削除は禁止。`audit_logs` の `actor_id` は残るため履歴は保持される。

## 3.4 監査ログ取得（要・運営 JWT）

運営スタッフが「誰が何をしたか」を確認するためのエンドポイント。

### GET `/api/v1/admin/events/:event_id/audit-logs`
- **保護**：`requireStaff`（`manager` / `viewer` 両方が閲覧可）＋ `requireEventMatchesJwt`
- **Query**：`page`・`limit`（ページング）、`action`（フィルタ、任意）
- **返却**：`{ logs: [ { id, actor_id, actor_display_name, actor_role, action, target_type, target_id, detail, created_at } ] }`
  - `actor_display_name` は `users.display_name` を JOIN して取得。アカウント削除済みなら NULL。
- **注意**：ログの削除・改ざん API は提供しない（証跡の完全性を保つ）。

## 3.5 既存 `admin/` ルートの preHandler 差し替え（要・既存ルート修正）

`requireAdmin`（`role === 'admin'` チェック）を廃止し、操作種別に応じて差し替える。

| 対象ルート | 現在 | 変更後 |
|-----------|------|--------|
| GET 系（ダッシュボード・一覧） | `requireAdmin` | `requireStaff` |
| POST / PATCH / DELETE 系（ブース・カテゴリ・アンケート作成/編集/削除） | `requireAdmin` | `requireManager` |

- ルートのロジック本体は変更しない。preHandler の名前差し替えのみ。
- 各 POST/PATCH/DELETE 操作に `audit_logs` INSERT を追加する（同一トランザクション内）。

## 3.6 URL 組み立ての責務

- URL 文字列の生成は**サーバーの 1 箇所（ヘルパ関数）に集約**する。パス規約（`/join/:id`, `/admin/login?event=:id`）は frontend のルーティング仕様（frontend `.sdd/02-routing-urls.md`）と契約として一致させる。
- `FRONTEND_BASE_URL` 末尾スラッシュの正規化を行う。

## 3.7 環境変数の追加

| 変数 | 用途 | 例 |
|------|------|----|
| `FRONTEND_BASE_URL` | 発行 URL のオリジン | `https://event-support.example.com` |
| `ORGANIZER_REGISTRATION_KEY` | 主催者登録の保護キー（invite モード時に必須・Secret Manager） | ランダム 32 文字以上 |
| `ORGANIZER_SIGNUP_MODE` | 主催者登録の認証モード切り替え | `invite`（既定） / `open` |

`src/config.ts` の zod スキーマに追加。`FRONTEND_BASE_URL` 未設定時は `CORS_ORIGIN` 先頭をフォールバックにする案もあり（実装時に決定）。
