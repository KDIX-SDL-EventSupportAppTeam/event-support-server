# 01. 全体像・ロール・影響範囲

## 1. ロール定義

| ロール | スコープ | JWT に持つ識別子 | 認証経路 | 主な権限 |
|--------|----------|------------------|----------|----------|
| プラットフォーム運営 | 全体 | （アカウントなし） | 環境変数キー | 主催者アカウントの初回発行を保護 |
| 主催者 Organizer ★新規 | イベント横断 | `organizer_id`（`event_id` なし） | `/api/v1/organizer/auth/*` | 自分のイベントの作成・編集・URL 発行 |
| 運営管理者 Manager（既存ロール拡張） | イベント単位 | `event_id`, `role='manager'` | `/api/v1/auth/login` | 既存の運営機能すべて（作成・編集・削除） |
| 運営閲覧者 Viewer ★新規ロール | イベント単位 | `event_id`, `role='viewer'` | `/api/v1/auth/login` | ダッシュボード・一覧・監査ログの閲覧のみ |
| 参加者 Participant（既存） | イベント単位 | `event_id`, `role='participant'` | `/api/v1/auth/login` | チェックイン等 |

**重要：** 主催者 JWT と既存 JWT は別物。`event_id` の有無で峻別する（[04-auth.md](./04-auth.md) 参照）。
既存の `role='admin'` はマイグレーションで `manager` に変換する（[02-data-model.md](./02-data-model.md) 2.3）。

## 2. 中核フロー：イベント作成と URL 発行

```
主催者がポータルでイベント概要を入力（名前・日程・会場・初期管理者の email/password）
   │
   ▼
POST /api/v1/organizer/events           ← 主催者 JWT で認証
   │
   ├─ 1. events に INSERT（id=UUID 自動生成, organizer_id=主催者）
   ├─ 2. users に初期管理者を INSERT（event_id, role='manager', 入力された email/password）
   ├─ 3. audit_logs に INSERT（action='staff.invite'）
   └─ 4. レスポンスで event_id と発行 URL を返す
   │
   ▼
レスポンス:
   {
     event: { id, name, date_start, date_end, venue },
     initial_manager: { id, email },
     urls: {
       participant: "https://<frontend>/join/<event_id>",
       admin:       "https://<frontend>/admin/login?event=<event_id>"
     }
   }

※ 追加スタッフ（manager / viewer）は作成後に POST /organizer/events/:id/staff で招待する。
```

- **イベント ID は従来どおりサーバー側で UUID 生成**。URL は frontend のオリジン（環境変数 `FRONTEND_BASE_URL`）＋固定パスで組み立てるだけ。
- **新しいインフラ・サブドメイン・再デプロイは不要。** 既存 SPA の catch-all リライト（`firebase.json` / `app.yaml`）が新パス `/join/:eventId` をそのまま `index.html` に解決する。

## 3. 影響範囲

| 領域 | 変更 | 既存への影響 |
|------|------|--------------|
| DB スキーマ | `organizers`・`audit_logs` テーブル新設、`events.organizer_id` 追加、`users.role` 値拡張 | 既存行は `organizer_id=NULL`。`role='admin'`→`'manager'` へ変換。CASCADE 設計は維持 |
| 認証 | 主催者用 `requireOrganizer` 追加。`requireAdmin` を `requireManager`/`requireStaff` に置換 | `requireBearerAuth`・`requireEventMatchesJwt` は無変更 |
| ルート | `src/routes/v1/organizer/` を新設 | 既存 `routes/v1/*` は無変更。`admin/*` は **preHandler 差し替え＋監査ログ INSERT 追加**（ロジック本体は不変） |
| 環境変数 | `FRONTEND_BASE_URL`, `ORGANIZER_REGISTRATION_KEY`, `ORGANIZER_SIGNUP_MODE` を追加 | 既存変数は無変更 |
| 既存運営/参加者機能 | ロール判定の置換・監査ログ記録の追加 | 参加者機能は無変更。運営機能は権限境界が `manager`/`viewer` に分化 |
| デプロイ設定 | なし | なし |

## 4. 段階リリース方針

1. **Phase 1（基盤）** — `organizers`・`audit_logs` テーブル、`users.role` 拡張、preHandler 置換、主催者認証、イベント作成 API、URL 発行、**スタッフ招待（`POST /staff`）**、既存 admin 操作への監査ログ記録。最小で「作って URL が出る・スタッフを招待できる・操作が記録される」を達成
2. **Phase 2（管理 UI）** — イベント一覧取得・概要編集（PATCH）・削除、スタッフ一覧/ロール変更/削除、監査ログ閲覧 API
3. **Phase 3（任意）** — スタッフのパスワード再設定、イベント複製、公開ステート、URL のメール送信

Phase 1 で当初要件（GUI で作成→URL 自動発行→参加者/運営画面が開く＋ロール付きスタッフ管理＋操作証跡）を満たす。

## 5. 既存資産の流用

- 既存環境変数 `ADMIN_REGISTRATION_KEY` の発想（キーで登録を保護）を主催者登録に転用する。混乱を避けるため新名 `ORGANIZER_REGISTRATION_KEY` を推奨。
- パスワードハッシュ（bcrypt cost 10）・`sendOk`/`sendFail`・zod バリデーション・UUID 生成は既存ユーティリティをそのまま使う。
