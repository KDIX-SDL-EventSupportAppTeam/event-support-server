---
状態: 実装済み
最終更新: 2026-08-25
---

# API

**このファイルが API 契約の正本である。** フロントはここを参照する。

## 新規エンドポイント

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| GET | `/api/v1/events/:event_id/app-access` | **なし（公開）** | 実効開放状態の取得。完了画面が参照する |
| GET | `/api/v1/organizer/events/:event_id/app-access` | Bearer（organizer、所有のみ） | 設定値の取得（`updated_by` / `updated_at` を含む） |
| PUT | `/api/v1/organizer/events/:event_id/app-access` | Bearer（organizer、所有のみ） | 設定値の更新 |
| GET | `/api/v1/admin/events/:event_id/app-access` | Bearer（staff） | 運営スタッフ向けの読み取り専用 |
| GET | `/api/v1/events/:event_id/pre-survey/questions` | **なし（公開）** | 事前アンケート設問。未ログインでも見せる |

## GET /api/v1/events/:event_id/app-access（公開）

```json
{
  "event_id": "…",
  "is_open": false,
  "mode": "scheduled",
  "app_opens_at": "2026-10-16T00:30:00.000Z",
  "pre_survey_closes_at": "2026-10-15T14:59:59.000Z",
  "is_pre_survey_open": true,
  "server_time": "2026-10-15T05:00:00.000Z"
}
```

- **イベント名等の内部情報は返さない。** 存在しない `event_id` は 404
- `mode` は返してよい（UI の文言切り替えに使う）
- **`app_closes_at` / `updated_by` は返さない**

## PUT /api/v1/organizer/events/:event_id/app-access

```json
{
  "mode": "scheduled",
  "app_opens_at": "2026-10-16T00:30:00.000Z",
  "app_closes_at": null,
  "pre_survey_closes_at": "2026-10-15T14:59:59.000Z"
}
```

バリデーション:

- `mode` は3値のいずれか。必須
- `mode === 'scheduled'` のとき `app_opens_at` 必須
- `mode` が `open` / `closed` のときも `app_opens_at` は**保持する**（null 化しない）。
  予約に戻したときに値が残るようにするため
- `app_closes_at` を指定する場合は `app_opens_at` より後
- `pre_survey_closes_at` は任意。省略時は既存値を維持
- 不正は 400

レスポンスは更新後の設定値（organizer の GET と同形）。

**監査ログを1件書く**（`src/lib/audit.ts`）:
`action='update'`, `target_type='app_access'`, `target_id=event_id`,
`actor_role='organizer'`, `detail` に変更前後の値。

## GET /api/v1/events/:event_id/pre-survey/questions（公開）

```json
{
  "is_pre_survey_open": true,
  "pre_survey_closes_at": "2026-10-15T14:59:59.000Z",
  "questions": [
    {
      "id": "…uuid…",
      "question_key": "age_group",
      "label": "年代",
      "answer_type": "single",
      "required": true,
      "options": [{ "value": "twenties", "label": "20代" }]
    },
    {
      "id": "…uuid…",
      "question_key": "interest_categories",
      "label": "関心のある分野（複数選択可）",
      "answer_type": "multi",
      "required": true,
      "options": [{ "value": "<category_id>", "label": "AI・機械学習" }]
    }
  ]
}
```

`interest_categories` の `options` は **`categories` テーブルから生成する**（[P-10](01-concept.md)）。
DB の `options` 列は読まない。

## POST /api/v1/events/:event_id/survey/answers（既存を変更）

Bearer + `requireEventMatchesJwt`。

1. `is_pre_survey_open === false` なら **409**（`code: 'PRE_SURVEY_CLOSED'`）
2. `is_required` の設問が欠けていたら 400
3. `options` に無い `value` が来たら 400（**離散コードの整合性を守る。分析の前提**）
4. `answer_type` と値の型が一致すること（`single`→文字列 / `multi`→文字列配列 / `text`→文字列）
5. `(user_id, event_id)` で既存行を SELECT → あれば UPDATE、無ければ INSERT
6. レスポンスに `{ answered_at }` を返す

## 既存エンドポイントの変更

| エンドポイント | 変更 |
|---|---|
| `GET /events/:event_id/survey/questions` | `question_key` / `answer_type` と正規化済み `options` を返す |
| `GET /events/:event_id/public` | レスポンスに `app_access`（`is_open` / `mode` / `app_opens_at` / `pre_survey_closes_at`）を含める。完了画面の初期表示で1リクエスト減らせる |
| `POST /organizer/events` | `event_app_access` の既定行を作成する |
| `CRUD /admin/events/:event_id/survey-questions` | `question_key` / `answer_type` / `{value,label}` 形式の `options` に対応 |

## そのまま使うもの

- `POST /api/v1/auth/register`（サインアップ）
- `POST /api/v1/auth/login`（サインイン）

## ファイル配置

| ファイル | 責務 |
|---|---|
| `src/routes/v1/app-access.ts` | 公開 GET |
| `src/routes/v1/organizer/app-access.ts` | organizer の GET / PUT |
| `src/routes/v1/admin/app-access.ts` | staff の読み取り専用 GET |
| `src/lib/app-access.ts` | **実効開放状態の算出と既定値生成。判定ロジックはここだけに置く** |
| `src/routes/v1/survey.ts` | 既存。締切チェック・バリデーション・upsert を追加 |

`app.ts` の登録順は既存の並び（public → v1 → organizer → admin）に合わせる。
