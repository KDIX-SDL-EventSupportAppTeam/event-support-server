# 01. API 定義

すべて `sendOk` / `sendFail` の共通レスポンス形式・zod バリデーションに従う。
オーガナイザー系は `requireOrganizer` preHandler + 所有権チェック（下記 1.1）を必須とする。

---

## 1. 共通事項

### 1.1 所有権チェックの共通ヘルパー

`staff.ts` に埋め込まれている所有権チェックを `src/lib/organizer.ts`（新規）へ抽出する。

```
assertEventOwnedByOrganizer(db, eventId, organizerId): Promise<boolean>
  → SELECT id FROM events WHERE id = ? AND organizer_id = ? LIMIT 1
```

- false のとき呼び出し元は 403 `FORBIDDEN`「このイベントへのアクセス権限がありません」を返す
- 既存 `POST /organizer/events/:event_id/staff` もこのヘルパーに置き換える
- **注意**: 手動 SQL で作られた既存イベントは `organizer_id` が NULL のため、
  どのオーガナイザーからも見えない。これは仕様とする（必要なら運用で
  `UPDATE events SET organizer_id = ...` により紐づける。README 参照）

### 1.2 日時の返却形式

既存 admin API と同じく `'YYYY-MM-DDTHH:MM:SSZ'`（`replace(' ', 'T') + 'Z'`）に統一する。
開催ステータスはサーバーでは計算しない（フロントが導出する）。

---

## 2. イベント一覧（スタブ置換）

```
GET /api/v1/organizer/events
認証: Bearer（organizer JWT）
```

自分（`organizer_id = jwt.sub`）が所有するイベントを `date_start DESC` で全件返す。
ページネーションは導入しない（1 主催者あたり高々数十件の想定。必要になったら追加）。

**レスポンス `data`:**

```jsonc
{
  "events": [
    {
      "id": "uuid",
      "name": "Tech Fes 2026",
      "date_start": "2026-08-01T01:00:00Z",
      "date_end": "2026-08-01T09:00:00Z",
      "venue": "東京ビッグサイト",       // null 可
      "created_at": "2026-07-01T00:00:00Z",
      "stats": {
        "participants": 40,             // users WHERE role='participant'
        "booths": 18,
        "checkins": 123
      },
      "urls": {                          // buildEventUrls() で再生成（保存しない）
        "participant": "https://<front>/join/<id>",
        "admin": "https://<front>/admin/login?event=<id>"
      }
    }
  ]
}
```

**実装上の注意（N+1 回避）:**
イベントごとにカウントを取らず、所有イベント一覧を取得した後、
`WHERE event_id IN (...) GROUP BY event_id` の集計クエリを
users（role='participant'）/ booths / check_ins の 3 本だけ発行してマージする。
所有イベント 0 件なら集計クエリを発行せず `{ events: [] }` を返す。

---

## 3. イベント詳細（新設）

```
GET /api/v1/organizer/events/:event_id
認証: Bearer（organizer JWT）+ 所有権チェック
```

一覧と同じ 1 イベント分の構造（`{ "event": { ...一覧と同形 } }`）を返す。
存在しない・所有していない場合は 403（存在有無を漏らさないため 404 と区別しない）。

> イベント概要の**編集**は新設しない。既存 `PATCH /admin/events/:event_id` は
> manager JWT 用のため、オーガナイザーによる編集が必要になった場合は
> `PATCH /organizer/events/:event_id` を別途追加する（本フェーズでは
> フロント側も閲覧のみとし、編集は運営画面（manager）に委ねる）。

---

## 4. スタッフ管理（新設 3 本）

対象はイベント内の `role != 'participant'` のユーザー（manager / viewer / 旧 admin）。
旧 `admin` ロールの表示・集計は **manager と同等**として扱う。

### 4.1 スタッフ一覧

```
GET /api/v1/organizer/events/:event_id/staff
認証: Bearer（organizer JWT）+ 所有権チェック
```

```jsonc
{
  "staff": [
    {
      "id": "uuid",
      "email": "manager@example.com",
      "display_name": "運営担当",        // null は '' に正規化
      "role": "manager",                 // 'admin' は 'manager' に正規化して返す
      "created_at": "2026-07-01T00:00:00Z"
    }
  ]
}
```

並び順: `created_at ASC`（招待順）。

### 4.2 ロール変更

```
PATCH /api/v1/organizer/events/:event_id/staff/:user_id
認証: Bearer（organizer JWT）+ 所有権チェック
Body: { "role": "manager" | "viewer" }   // zod: z.enum
```

- 対象は当該イベントの `role != 'participant'` ユーザー。SELECT で存在確認し、無ければ 404
- **最後の manager ガード**: 変更後にイベントの manager（旧 admin 含む）が 0 人になる場合は
  409 `CONFLICT`「最後の管理者は閲覧者に変更できません」を返す
  （判定: `role='viewer'` への変更時、`COUNT(*) FROM users WHERE event_id=? AND role IN ('manager','admin') AND id != :user_id` が 0 なら拒否）
- 成功時: `{ "staff": { ...4.1 と同形の 1 件 } }`
- 監査ログ: action `staff.role_change`、detail `{ email, from_role, to_role }`

### 4.3 スタッフ削除

```
DELETE /api/v1/organizer/events/:event_id/staff/:user_id
認証: Bearer（organizer JWT）+ 所有権チェック
```

- 対象・存在確認は 4.2 と同じ
- **最後の manager ガード**: 削除後に manager が 0 人になる場合は 409
  「最後の管理者は削除できません」
- `DELETE FROM users WHERE id = ? AND event_id = ? AND role != 'participant'`
  （FK は ON DELETE CASCADE のため関連行も消えるが、スタッフは通常
  チェックイン等を持たない。持っていても仕様どおり削除してよい）
- 成功時: `{ "deleted": true }`
- 監査ログ: action `staff.remove`、detail `{ email, role }`

> **注意（発行済み JWT）**: ロール変更・削除しても、当人が保持中の JWT は
> 失効しない（トークンに role が焼き込まれている）。イベント終了 +24h で
> 自然失効する現行設計を許容する。即時失効が必要になったら別途
> トークンバージョン等を検討する。この制約は監査ログで追跡可能なことを前提に受容する。

---

## 5. 公開イベント情報（新設）

```
GET /api/v1/events/:event_id/public
認証: なし
```

JoinPage（「イベント ID をそのまま表示」している現状の TODO 解消）と
AdminLoginPage（`?event=` の UUID 生表示解消）のための最小限の公開情報。

```jsonc
{
  "event": {
    "id": "uuid",
    "name": "Tech Fes 2026",
    "date_start": "2026-08-01T01:00:00Z",
    "date_end": "2026-08-01T09:00:00Z",
    "venue": "東京ビッグサイト"          // null 可
  }
}
```

- 存在しない場合は 404
- **返してよいのは上記 5 フィールドのみ**（参加者数・スタッフ情報等は含めない）
- UUID は推測不能であることを認可の代わりとする（URL を知っている人 = 招待された人）
- 配置: `src/routes/v1/events-public.ts`（新規。既存 `booths.ts` 等の認証付き
  `/events/*` と preHandler 構成が異なるため、ファイルを分けて誤用を防ぐ）

---

## 6. 監査ログ action の追加一覧

`docs/ubiquitous-language.md` / 既存の action 一覧に以下を追記する。

| action | 発生箇所 | detail |
|--------|----------|--------|
| `staff.role_change` | 4.2 | `{ email, from_role, to_role }` |
| `staff.remove` | 4.3 | `{ email, role }` |

（`staff.invite` は Phase 1 で定義済み）

---

## 7. テスト

`tests/unit/` に以下を追加する（DbClient をモック）。

- 一覧: 所有イベントのみ返る／0 件で空配列／stats の集計マージ
- ロール変更・削除: 最後の manager ガード（409）／participant を対象にできない（404）
- 公開イベント情報: 5 フィールドのみ返る／存在しない ID で 404

実行記録は `docs/tests/runs/` に残す（既存運用どおり）。
