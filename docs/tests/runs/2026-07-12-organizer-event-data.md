# テスト実行記録 — 2026-07-12（イベントデータ全削除の organizer 専用エンドポイント再設計）

## 何を

### 対象（src）

- `src/routes/v1/organizer/event-data.ts`（新規。`DELETE /organizer/events/:event_id/event-data`）
- `src/app.ts`（`adminEventDataRoutes` の import/register を削除し `organizerEventDataRoutes` を organizer 群へ登録）
- `src/routes/v1/admin/event-data.ts`（削除。旧 URL は 404 化）
- `src/lib/event-data/clear-all.ts`（JSDoc 更新、users 削除を `role IN ('participant','exhibitor')` へ拡張）
- `src/lib/sample-data/constants.ts`（`hasBoothCategoriesTable` を try/catch 化し失敗時 false を返す）
- `AGENTS.md` / `docs/ubiquitous-language.md`（エンドポイント表・監査 action 一覧の同期）

### テストコード（tests）

- `tests/unit/organizer-event-data.test.ts`（新規、7 ケース）

## なぜ

`改修プラン/三上issue_2026-07/server_64_イベント全削除organizer.md` の実装。issue #64「イベントデータ全削除を organizer 専用エンドポイントとして再設計」に対応。徳山さんの裁定により案B（既存 organizer アクター＋新ルート）を採用し、旧 `/admin/.../event-data` は完全撤去（404 化）。同設計書 §9-5（`hasBoothCategoriesTable` の堅牢化）・§9-6（users 削除の exhibitor 拡張）を同梱。

## 実行コマンド

```bash
npm run build
npm test
grep -n "EventDataRoutes" src/app.ts
ls src/routes/v1/admin/event-data.ts
```

## 環境

- ブランチ: `feat/organizer-event-data`
- MySQL: ユニットテストは `makeDb` による SQL 正規表現モック。加えてローカル Docker MySQL（seed-dev）での実機 E2E を実施（下記）
- 関連 PR / Issue: #64（server）/ 対応フロント #54（frontend、別途）

## 結果

- `npm run build` — exit 0（`tsc -p tsconfig.build.json` エラーなし）
- `npm test` — 全 5 ファイル・31 テスト成功（`organizer-event-data.test.ts` 7 件含む）
  - 正常系: organizer JWT＋所有イベント＋正しい confirm → 200、`cleared` 件数一致、DELETE 系 SQL と audit INSERT の発行を確認
  - confirm 誤字 → 422、DELETE 系 SQL 発行なしを確認
  - confirm 欠落（空 body）→ 422
  - 非所有 organizer（所有確認 SELECT が空）→ 403、DELETE なし
  - manager の access token → 401（F10 のとおり 403 ではなく 401）
  - Authorization ヘッダなし → 401
  - audit INSERT が reject されても本体は 200（削除成功を巻き込まない）
- `grep -n "EventDataRoutes" src/app.ts` — organizer 側の import/register の 2 行のみ（`adminEventDataRoutes` は残存なし）
- `ls src/routes/v1/admin/event-data.ts` — `No such file or directory`（削除済みを確認）

## 実機 E2E（ローカル Docker・2026-07-12 実施）

設計書 §7 の手順どおり。seed-dev の organizer（`organizer@example.com`）を seed イベントに `UPDATE events SET organizer_id=...` で紐付け、manager でサンプルデータ生成後に実施。すべて期待どおり:

| # | 操作 | 結果 |
|---|---|---|
| 1 | confirm 誤字（`{"confirm":"DELETE"}`） | 422 |
| 2 | manager トークンで新 URL | 401 |
| 3 | 旧 `/admin/.../event-data`（manager トークン） | 404 |
| 4 | organizer＋正しい confirm | 200・`cleared` 10 項目（recommendations:101 / ratings:162 / checkins:223 / booths:21 / participants:50 ほか） |
| 5 | 直後にもう一度同じ DELETE（冪等性） | 200・全項目 0 件 |
| 6 | `GET /admin/.../audit-logs` 先頭行 | `action: event_data.clear`・`actor_role: organizer`・detail に 10 項目の件数 |
| 7 | manager で再ログイン（運営アカウント残置） | 200 |

- さくら相当の information_schema 拒否シナリオの実機再現は未実施（ユニットの try/catch 検証と設計 §3-6 の論拠に依拠）。

## メモ
- 本番運用の前提（本番 organizers テーブルへのアカウント存在、`events.organizer_id` の backfill 要否）は設計書 §9-3 のとおり未確認・三上くん確認待ち。
- 旧 URL 撤去に伴うフロント側（frontend #54）の呼び出し元差し替えは本作業のスコープ外。
