# テスト実行記録 — 2026-07-13（イベントにアンケートURL追加：作成/編集API・参加者向けAPI）

## 何を

### 対象（src）

- `src/routes/v1/events-public.ts`（`GET /events/:event_id/public` に `survey_url` を追加）
- `src/routes/v1/admin/events.ts`（`patchEventBody` に `survey_url` を追加、GET/PATCH の SELECT・response・動的 UPDATE 分岐に反映）
- `src/routes/v1/organizer/events.ts`（`EventRow` 型・SELECT 3箇所・`toEventPayload`・`createEventBody`・INSERT 2箇所に `survey_url` を反映）

### テストコード（tests）

- `tests/unit/organizer-portal.test.ts`
  - `GET /events/:id/public` の「5 フィールドのみ返す」テストを「6 フィールドのみ返す」に更新（`survey_url` を含む）
  - `GET /organizer/events` 一覧テストの mock row / 期待値に `survey_url: null` を追加
  - 新規 describe「POST /organizer/events の survey_url バリデーション」を追加（有効URL→201・INSERT SQL に survey_url を含む／`"not-a-url"`→422／`"javascript:alert(1)"`→422／キー省略→201）

## なぜ

- issue #58（イベントにアンケートURL追加）。#52（`events.survey_url` カラム追加マイグレーション）適用済みが前提。
- 設計書: `University/Research/02_コード/P3_2026/改修プラン/三上issue_2026-07/server_58_アンケートURL.md`（Fable 5 / 2026-07-07）

## 実行コマンド

```bash
npm run build
npm test
```

## 環境

- ブランチ: `feat/event-survey-url`（origin/develop 基点）
- MySQL: 未使用（ユニットテストは `DbClient` モックのみ。ビルドのみ tsc）
- 関連 PR / Issue: server #58

## 結果

- `npm run build` → exit 0（型エラーなし）
- `npm test` → exit 0（4 test files / 28 tests passed。`organizer-portal.test.ts` は 16 tests、うち新規4件が今回追加分）

## メモ

- issue 記載の `PUT /organizer/events/:event_id` は存在しないため新設せず、編集は既存の `PATCH /admin/events/:event_id` に `survey_url` を追加する形で対応（設計書 §9 D1／要三上確認事項）。
- 参加者向けは既存の認証なし `GET /events/:event_id/public` を6フィールドに拡張する方針（新規エンドポイントは作らない。設計書 §9 D2／要三上確認事項）。
- バリデーションは `z.string().url().max(2048).regex(/^https?:\/\//).nullable().optional()`。`.regex` により `javascript:` 等のスキームを排除。
- 空文字→null 正規化はフロント側の責務（既存 venue の前例踏襲）。サーバは `''` を 422 で拒否する。
- curl による実機検証（設計書 §7）は、その後司令塔セッションがローカル Docker MySQL + `npm run dev` で全項目実施し合格（2026-07-13）:
  - survey_url 付き作成 → 201・`data.event.survey_url` が送信値と一致
  - `not-a-url` / `javascript:alert(1)` → いずれも 422 VALIDATION_ERROR
  - `GET /events/:id/public` のキーが id/name/date_start/date_end/venue/survey_url の 6 個ちょうど
  - PATCH で null → 公開API null → 再設定で追随（往復）
  - survey_url 省略の作成 → 201・survey_url null（後方互換）
  - `GET /organizer/events`（一覧）/ `GET /organizer/events/:id`（詳細）にも survey_url が含まれる
