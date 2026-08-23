# 04. 認証・権限設計

## 4.1 JWT の二系統

| 系統 | payload | 発行元 | 検証 preHandler |
|------|---------|--------|-----------------|
| 既存（運営/参加者） | `{ sub, event_id, display_name, role }` | `/api/v1/auth/*` | `requireBearerAuth` →（`requireEventMatchesJwt` / `requireManager` / `requireStaff`） |
| 主催者 ★新規 | `{ sub, scope: 'organizer', display_name }` | `/api/v1/organizer/auth/*` | `requireOrganizer` |

**識別の原則**：`scope === 'organizer'` を主催者 JWT の判定キーにする。`event_id` を持たない。既存 JWT には `scope` を付けない（または `scope: 'event'`）ことで取り違えを防ぐ。署名鍵は共通（`JWT_SECRET`）でよいが、`scope` 不一致のトークンは各 preHandler で拒否する。

## 4.2 preHandler の更新・追加

`src/plugins/auth.ts` への変更。**既存 `requireBearerAuth`・`requireEventMatchesJwt` は無変更。`requireAdmin` を廃止し、`requireManager`・`requireStaff` に置き換える。**

### 廃止：`requireAdmin`

現在 `role === 'admin'` を確認しているが、`admin` という role 値が `manager` に改名されるため廃止。

### 新設：`requireManager`（旧 requireAdmin 相当）

```
requireManager(req, reply):
  1. requireBearerAuth を通す
  2. role !== 'manager' なら 403「運営管理者権限が必要です」
```

データの作成・編集・削除を伴う操作に使う。

### 新設：`requireStaff`（閲覧者も通す）

```
requireStaff(req, reply):
  1. requireBearerAuth を通す
  2. role が 'manager' でも 'viewer' でもなければ 403「運営スタッフ権限が必要です」
```

ダッシュボード・一覧取得など、`viewer` にも許可する読み取り操作に使う。

### 既存ルートへの影響

既存 `admin/` 配下ルートは現在 `requireAdmin` を使っている。**これを `requireManager` または `requireStaff` に置き換える対応が必要**。判断基準：

| 操作の種類 | 変更後 preHandler |
|-----------|------------------|
| ダッシュボード取得、一覧取得（GET） | `requireStaff` |
| ブース/カテゴリ/アンケートの作成・編集・削除 | `requireManager` |
| スタッフ一覧の取得 | `requireStaff` |

これは既存ルートへの変更を伴うが、**preHandler の差し替えのみでロジックは変わらない**。

### 新設：`requireOrganizer`

```
requireOrganizer(req, reply):
  1. Authorization: Bearer を検証
  2. payload.scope !== 'organizer' なら 403「主催者権限が必要です」
  3. req.organizer = { id: payload.sub, display_name } を確立
```

## 4.3 リソース所有チェック

イベント系エンドポイント（`/organizer/events/:event_id` 配下）は、URL の `event_id` が**ログイン主催者の所有**（`events.organizer_id === req.organizer.id`）であることを DB で確認してから処理する。

- 専用ヘルパ `assertEventOwnedByOrganizer(eventId, organizerId)` を用意し、不一致は 404（存在秘匿）を返す。
- 既存の `requireEventMatchesJwt`（JWT の event_id と URL を突合）とは別物。

## 4.4 スタッフ招待とロール付与

主催者がイベントスタッフを招待し、ロールを付与するフロー。

```
主催者 POST /organizer/events/:id/staff
  { email, password, display_name, role: 'manager' | 'viewer' }
  ↓
  users に INSERT（event_id, email, bcrypt(password), role）
  audit_logs に INSERT（action='staff.invite', detail={email, role}）
  ↓
  返却：{ staff: { id, email, display_name, role } }
```

- スタッフは招待時に主催者が設定したパスワードで初回ログイン（`/api/v1/auth/login`）。
- 招待後のパスワード変更 API は Phase 2。現状は主催者が設定したものを運営スタッフに直接伝える運用。
- URLはコピペ可能な形式で画面に表示（メール送信は今回実装しない）。

### ロール変更

```
主催者 PATCH /organizer/events/:id/staff/:user_id
  { role: 'manager' | 'viewer' }
  ↓
  users.role を UPDATE
  audit_logs に INSERT（action='staff.role_change', detail={before, after}）
```

- 最後の `manager` のロールを `viewer` に下げることは禁止（`manager` 0 人を防ぐ）。
- 主催者自身の変更は不可（エラー 400）。

## 4.5 監査ログの記録方針

`audit_logs` テーブル（[02-data-model.md](./02-data-model.md) 2.4）への書き込みルール。

- **書き込みタイミング**：各ルートハンドラでメイン処理と同一トランザクション内で INSERT する。
- **書き込み責務**：ルートハンドラが直接書く（サービス層のラッパ関数 `insertAuditLog(conn, payload)` を用意して重複排除）。
- **記録対象**：データを変更する操作（CREATE / UPDATE / DELETE）に限定。GET はログしない。
- **`viewer` の操作**：`viewer` は変更操作を実行できないため、原則としてログは `manager` の操作のみに発生する。

## 4.6 主催者登録の認証モード（切り替え可能）

主催者の発行方式を**設定で切り替えられる**ようにする。今回は「簡単な方（招待制）」を実装する。

| モード | 値 | 挙動 | スパム対策 |
|--------|----|----|-----------|
| 招待制（今回実装） | `invite` | `/organizer/auth/register` は `ORGANIZER_REGISTRATION_KEY` 必須 | キー秘匿 |
| 自由登録（将来） | `open` | キー不要で誰でも登録。メール認証＋レート制限を併用 | メール認証・レート制限 |

**実装方針：**

- 環境変数 `ORGANIZER_SIGNUP_MODE`（既定 `invite`）を `src/config.ts` の zod スキーマに追加。
- 分岐を `assertCanRegisterOrganizer(req)` ヘルパ 1 箇所に閉じ込め、ハンドラ本体はモード非依存にする。
- `open` モードは関数シグネチャのみ用意し、有効化は別フェーズ／別 ADR。

## 4.7 権限境界のまとめ

| 操作 | 必要な認証 |
|------|-----------|
| 主催者の発行 | 登録キー（プラットフォーム運営） |
| イベント作成・編集・削除 | 主催者 JWT ＋ 所有チェック |
| スタッフ招待・ロール変更 | 主催者 JWT ＋ 所有チェック |
| ブース/カテゴリ/アンケートの作成・編集・削除 | 運営 JWT（`role='manager'`）= `requireManager` |
| ダッシュボード・一覧取得 | 運営 JWT（`role='manager'` or `'viewer'`）= `requireStaff` |
| チェックイン等 | 参加者 JWT（`role='participant'`）※無変更 |
