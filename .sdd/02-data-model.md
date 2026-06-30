# 02. データモデル変更

正本は `db/migrations/01_initial_schema.sql`。本機能では**新規テーブル 2 つ + 既存テーブルへの変更**を行う。破壊的変更はしない。

## 2.1 新規テーブル `organizers`

イベント横断の主催者アカウント。`event_id` を持たない点が `users` との決定的な違い。

```sql
CREATE TABLE organizers (
  id            CHAR(36)     PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  password_hash TEXT         NOT NULL,
  display_name  TEXT,                       -- 団体名
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_organizer_email (email)     -- email はプラットフォーム全体で一意
) ENGINE=InnoDB;
```

- `users.uq_email_event`（email × event_id で一意）と異なり、主催者の email は**全体で一意**。
- 認証方式は既存 users と同様 bcrypt。Google ログインは Phase 1 対象外。

## 2.2 既存テーブル `events` へのカラム追加

```sql
ALTER TABLE events
  ADD COLUMN organizer_id CHAR(36) NULL AFTER id,
  ADD CONSTRAINT fk_events_organizer
      FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE SET NULL;
```

- **NULL 許容**：既存イベント（手動投入分）は `organizer_id=NULL` のまま有効。
- `ON DELETE SET NULL`：主催者削除でイベント実データを消さない（参加者データ保護優先）。

## 2.3 既存テーブル `users` のロール拡張

`role` カラムの値を拡張し、運営スタッフのロール区分を持たせる。

```sql
ALTER TABLE users
  MODIFY COLUMN role VARCHAR(20) NOT NULL DEFAULT 'participant';
```

**role の値と意味：**

| 値 | 区分 | できること |
|----|------|-----------|
| `participant` | 参加者 | チェックイン・投票・ブース閲覧（既存・無変更） |
| `manager` | 運営管理者 | ブース/カテゴリ/アンケートの作成・編集・削除、ダッシュボード閲覧、スタッフ管理 |
| `viewer` | 運営閲覧者 | ダッシュボード・ブース一覧・チェックイン状況の閲覧のみ。データの作成・編集・削除は不可 |

**既存コードへの影響：**

- `requireAdmin`（`src/plugins/auth.ts`）は現在 `role === 'admin'` を確認している。`role` の取りうる値が変わるため、**この preHandler の更新が必要**（詳細は [04-auth.md](./04-auth.md) 4.2）。
- 既存の `role='admin'` データがある場合、マイグレーション時に `manager` へ変換する。

```sql
-- マイグレーション時の既存データ変換
UPDATE users SET role = 'manager' WHERE role = 'admin';
```

## 2.4 新規テーブル `audit_logs`（監査ログ）

誰が・いつ・何をしたかをさかのぼるための証跡テーブル。操作の取り消しには使わない（あくまで記録・参照用）。

```sql
CREATE TABLE audit_logs (
  id           CHAR(36)     PRIMARY KEY,
  event_id     CHAR(36)     NOT NULL,
  actor_id     CHAR(36)     NOT NULL,          -- 操作したユーザーの id (users.id)
  actor_role   VARCHAR(20)  NOT NULL,          -- 操作時点の role（ログ取得時点で確定）
  action       VARCHAR(50)  NOT NULL,          -- 操作の種類（下記一覧）
  target_type  VARCHAR(50)  NOT NULL,          -- 操作対象の種別（booth / category / check_in 等）
  target_id    CHAR(36),                       -- 操作対象の id（削除済みでも id は残す）
  detail       JSON,                           -- 変更前後の値など補足情報（任意）
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  -- actor_id は users(id) を参照しない（ユーザー削除後も履歴を保持するため）
) ENGINE=InnoDB;
```

**action の値（初期定義・拡張可）：**

| action | 意味 |
|--------|------|
| `booth.create` | ブース作成 |
| `booth.update` | ブース編集 |
| `booth.delete` | ブース削除 |
| `category.create` | カテゴリ作成 |
| `category.update` | カテゴリ編集 |
| `category.delete` | カテゴリ削除 |
| `checkin.delete` | チェックイン取り消し（将来実装時に追加） |
| `staff.invite` | スタッフ招待 |
| `staff.role_change` | スタッフのロール変更 |
| `survey.create` | アンケート作成 |
| `survey.update` | アンケート編集 |
| `survey.delete` | アンケート削除 |

**設計の論点：**

- `actor_id` は `users(id)` への FK を張らない。アカウント削除後も「誰が消したか」の記録を残す必要があるため。`actor_role` も操作時点の値をそのまま保存する。
- `detail` JSON には変更前後の値（例：`{ "before": { "name": "旧名" }, "after": { "name": "新名" } }`）を格納する。実装時に構造を決定すること。
- ログの書き込みは各ルートハンドラから明示的に呼ぶ（トランザクション内で本体処理と同時に INSERT）。別サービス・非同期処理にはしない（Phase 1）。

## 2.5 マイグレーション運用

- `db/migrations/` に連番ファイルを追加する想定。
  - `02_organizers.sql`：`organizers` テーブル・`events.organizer_id`
  - `03_staff_roles.sql`：`users.role` 値の変換・`audit_logs` テーブル
- `01_initial_schema.sql` は履歴として直接編集しない。
- 冪等性のため `CREATE TABLE IF NOT EXISTS` / カラム存在チェックを検討（既存マイグレーション方式に合わせること）。

## 2.6 データ整合性の論点（実装時に確認）

| 論点 | 方針案 |
|------|--------|
| スタッフの email 重複 | `users.uq_email_event`（email × event_id）で制御。同一イベント内で同 email の招待は 409 |
| 主催者削除時のイベント | `organizer_id=NULL` で孤児化。Phase 1 では主催者削除 API 未提供で回避 |
| 1 主催者あたりのイベント数上限 | Phase 1 は無制限。スパム懸念があればレート制限で対応 |
| `manager` が 0 人になるケース | スタッフ削除・ロール降格時に「最後の manager」かチェックし禁止する（またはイベントオーナー制度で保護）|
