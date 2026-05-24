# API・WebSocket 設計

REST の共通仕様・エンドポイント・socket.io イベントです。

**認証方式:** JWT（`Authorization: Bearer {token}`）

**実装（2026-05）:** リポジトリの [`server/`](../../server/) に Fastify 5 で `/api/v1` を実装済み（本書の REST 形状に準拠）。**未実装:** WebSocket（socket.io）、`POST /auth/google`、多数の運営管理 CRUD。

**関連:** [設計インデックス](./README.md) · [システム・サーバー設計](./system-server.md) · [DB設計](./database.md) · [フロントエンド](./frontend.md)

## 14. 共通仕様

### ベースURL
```
開発環境: http://localhost:3000/api/v1
本番環境: https://api.example.com/api/v1
```

### 認証
JWT認証が必要なエンドポイントは🔒マークで示す。

```
Authorization: Bearer {token}
```

JWTの有効期限はイベント終了時刻（`events.date_end`）に合わせて設定する。

### レスポンス形式

```json
// 成功
{ "success": true, "data": { ... } }

// 失敗
{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "認証が必要です" } }
```

### 主なエラーコード

| コード | HTTPステータス | 説明 |
|--------|--------------|------|
| `UNAUTHORIZED` | 401 | 認証が必要 |
| `FORBIDDEN` | 403 | 権限がない |
| `NOT_FOUND` | 404 | リソースが存在しない |
| `CONFLICT` | 409 | 重複（例：同じブースに二重チェックイン） |
| `VALIDATION_ERROR` | 422 | バリデーションエラー |
| `INTERNAL_ERROR` | 500 | サーバーエラー |

---

## 15. 認証 API

> **実装状況メモ（2026-05時点）**  
> ログイン画面はアプリフローのモックとして機能しており、認証の詳細要件は未確定。  
> メール送信（登録確認・パスワードリセット）は要件確定後に実装する。  
> Google OAuth は将来対応予定。バックエンドリプレイス初期は `/auth/login` のみ実装する。

### POST /auth/register
```json
// リクエスト
{ "event_id": "uuid", "email": "user@example.com", "password": "password123", "display_name": "山田太郎" }

// レスポンス
{ "success": true, "data": { "token": "eyJhbGci...", "user": { "id": "uuid", "display_name": "山田太郎", "event_id": "uuid" } } }
```

### POST /auth/login
```json
// リクエスト
{ "event_id": "uuid", "email": "user@example.com", "password": "password123" }

// レスポンス
{ "success": true, "data": { "token": "eyJhbGci...", "user": { "id": "uuid", "display_name": "山田太郎", "event_id": "uuid" } } }
```

### POST /auth/google
> **未実装（将来対応）**

```json
// リクエスト
{ "event_id": "uuid", "google_token": "google_oauth_token" }

// レスポンス
{ "success": true, "data": { "token": "eyJhbGci...", "user": { "id": "uuid", "display_name": "山田太郎", "event_id": "uuid" } } }
```

---

## 16. アンケート API

### GET /events/:event_id/survey/questions 🔒
固定設問とイベント固有設問を両方返す。

```json
{
  "success": true,
  "data": {
    "fixed_questions": [
      { "key": "age_range", "label": "年齢層", "options": ["10代", "20代", "30代", "40代", "50代以上"] },
      { "key": "occupation", "label": "職業", "options": ["学生", "会社員", "経営者", "その他"] },
      { "key": "industry", "label": "業種", "options": ["IT", "製造", "金融", "医療", "その他"] }
    ],
    "custom_questions": [
      { "id": "uuid", "question_text": "興味のある分野を選んでください", "options": ["AI", "Web", "ハードウェア", "デザイン"], "display_order": 1, "is_required": true }
    ]
  }
}
```

### POST /events/:event_id/survey/answers 🔒
```json
// リクエスト
{ "age_range": "20代", "occupation": "学生", "industry": "IT", "custom_answers": { "uuid（設問ID）": "AI" } }

// レスポンス
{ "success": true, "data": { "survey_answer_id": "uuid" } }
```

---

## 17. ブース API

### GET /events/:event_id/booths 🔒
クエリパラメータ：`category_id`（任意）

```json
{
  "success": true,
  "data": {
    "booths": [
      { "id": "uuid", "name": "AIスタートアップブース", "description": "最新のAI技術を展示しています", "category": { "id": "uuid", "name": "テクノロジー" }, "tags": ["AI", "スタートアップ"], "labels": ["🔥 急上昇中"], "checkin_count": 42, "avg_rating": 4.2, "is_checked_in": false }
    ]
  }
}
```

### GET /events/:event_id/booths/:booth_id 🔒
```json
{
  "success": true,
  "data": {
    "id": "uuid", "name": "AIスタートアップブース",
    "labels": ["🔥 急上昇中", "💎 じっくり系"],
    "stats": { "checkin_count_total": 42, "checkin_count_last_10min": 5, "checkin_count_last_30min": 12, "avg_rating": 4.2, "avg_stay_minutes": 18 },
    "is_checked_in": false
  }
}
```

---

## 18. チェックイン API

### POST /events/:event_id/checkins 🔒
QRスキャンと手動コード入力の両方をこのエンドポイントで処理する。

```json
// リクエスト
{ "method": "qr", "booth_id": "uuid", "checked_in_at": "2026-05-12T10:30:00+09:00" }
// または
{ "method": "manual", "manual_code": "ABC123", "checked_in_at": "2026-05-12T10:30:00+09:00" }

// レスポンス
{ "success": true, "data": { "checkin_id": "uuid", "booth": { "id": "uuid", "name": "AIスタートアップブース" }, "synced_at": "2026-05-12T10:30:01+09:00" } }
```

エラーケース：存在しない手動コード → `NOT_FOUND`、二重チェックイン → `CONFLICT`

### GET /events/:event_id/checkins 🔒
自分のチェックイン履歴を取得する。

---

## 19. 評価 API

### POST /events/:event_id/checkins/:checkin_id/rating 🔒
スキップした場合はこのエンドポイントを叩かない。

```json
// リクエスト
{ "rating": 4 }

// レスポンス
{ "success": true, "data": { "rating_id": "uuid" } }
```

---

## 20. 推薦 API

### GET /events/:event_id/recommendations 🔒
```json
{
  "success": true,
  "data": {
    "recommendation_id": "uuid",
    "algorithm": "mab",
    "booths": [
      { "id": "uuid", "name": "AIスタートアップブース", "labels": ["🔥 急上昇中"], "reason": "recommend" },
      { "id": "uuid", "name": "デザインブース", "labels": ["💎 じっくり系"], "reason": "semi_recommend" },
      { "id": "uuid", "name": "ハードウェアブース", "labels": ["🎲 意外な人気"], "reason": "discovery" }
    ]
  }
}
```

### POST /events/:event_id/recommendations/:recommendation_id/select 🔒
```json
// リクエスト
{ "selected_booth_id": "uuid" }
```

---

## 21. 運営ダッシュボード API

JWTのペイロードに`role: "admin"`が含まれている場合のみアクセス可能。

### GET /admin/events/:event_id/dashboard 🔒
```json
{
  "success": true,
  "data": {
    "summary": { "total_participants": 312, "total_checkins": 891, "avg_checkins_per_user": 2.9 },
    "booths": [
      { "id": "uuid", "name": "AIスタートアップブース", "checkin_count": 42, "avg_rating": 4.2, "checkin_count_last_10min": 5,
        "visitor_breakdown": { "age_range": { "20代": 18, "30代": 14 }, "occupation": { "学生": 20, "会社員": 15 } } }
    ],
    "checkin_timeline": [ { "time": "10:00", "count": 23 }, { "time": "10:10", "count": 31 } ]
  }
}
```

### GET /admin/events/:event_id/participants 🔒
クエリパラメータ：`page`（デフォルト1）、`limit`（デフォルト50）

---

## 22. 管理画面 API

### イベント管理
- `POST /admin/events` — イベント新規作成

### カテゴリ管理
- `GET /admin/events/:event_id/categories` — 一覧取得
- `POST /admin/events/:event_id/categories` — 追加
- `DELETE /admin/events/:event_id/categories/:category_id` — 削除（紐づくブースがある場合はエラー）

### アンケート設問管理
- `GET /admin/events/:event_id/survey/questions` — 一覧取得
- `POST /admin/events/:event_id/survey/questions` — 追加
- `PUT /admin/events/:event_id/survey/questions/:question_id` — 更新
- `DELETE /admin/events/:event_id/survey/questions/:question_id` — 削除

### ブース管理
- `GET /admin/events/:event_id/booths` — 一覧取得（全情報含む）
- `PUT /admin/events/:event_id/booths/:booth_id` — 手動更新
- `DELETE /admin/events/:event_id/booths/:booth_id` — 削除
- `GET /admin/events/:event_id/booths/:booth_id/qrcode` — QRコード取得（印刷用）

### イベントデータエクスポート

イベント終了時に主催者がトリガーを発火することで、来場者データを Google Sheets に書き出す。

#### POST /admin/events/:event_id/export/sheets 🔒

```json
// レスポンス
{ "success": true, "data": { "spreadsheet_url": "https://docs.google.com/spreadsheets/d/..." } }
```

出力内容：参加者一覧（属性・チェックイン数・訪問ブース履歴）、ブース別集計（来場数・平均評価）。  
Google Sheets API（サービスアカウント認証）を使用。出力先のスプレッドシートは環境変数 `EXPORT_SPREADSHEET_ID` で指定する。

---

## 23. Googleフォーム連携 API

JWTではなく専用APIキーで認証（`X-Api-Key: {key}`）。

### POST /webhook/booths/sync
`google_form_response_id`でupsertする。新規作成時は`manual_code`とQRコードを自動生成する。

```json
// リクエスト
{ "event_id": "uuid", "google_form_response_id": "response_id", "booth": { "name": "AIスタートアップブース", "description": "...", "category_name": "テクノロジー", "tags": ["AI"] } }

// レスポンス
{ "success": true, "data": { "booth_id": "uuid", "action": "created" } }
```

---

## 24. WebSocket イベント一覧

socket.ioを使用。接続時にJWTで認証する。

### 参加者向け

| イベント名 | 方向 | 説明 |
|-----------|------|------|
| `recommendation:updated` | Server → Client | チェックイン後に推薦が更新された |
| `booth:label:updated` | Server → Client | ブース特性ラベルが更新された |

### 運営向け

| イベント名 | 方向 | 説明 |
|-----------|------|------|
| `dashboard:checkin` | Server → Client | 新しいチェックインが発生した |
| `dashboard:stats:updated` | Server → Client | 集計データが更新された |

```json
// dashboard:checkin のペイロード
{ "booth_id": "uuid", "booth_name": "AIスタートアップブース", "user": { "display_name": "山田太郎", "age_range": "20代", "occupation": "学生" }, "checked_in_at": "2026-05-12T10:30:00+09:00" }
```
