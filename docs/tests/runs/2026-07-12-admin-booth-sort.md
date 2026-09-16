# テスト実行記録 — 2026-07-12（運営向けブース別ソート付き一覧・集計API #55）

## 何を

### 対象（src）

- `src/routes/v1/admin/admin-booths.ts`（既存の POST/PATCH/DELETE はそのまま。GET を新規追加。`boothListQuery`／`SORT_SQL`／`DIR_SQL` を新規 export）

### テストコード（tests）

- `tests/unit/admin-booth-sort.test.ts`（新規・15ケース。`boothListQuery`/`SORT_SQL` 単体4件、GET ルートのソート断片組み立て・レスポンス整形7件、認可4件）

## なぜ

Issue #55（運営向けブース別ソート付き一覧・集計API）。設計書 `改修プラン/三上issue_2026-07/server_55_運営コメント一覧API.md` §4・§5（手順1〜3・5）に基づく。#54（ブースコメントAPI、同ブランチに同梱済み）で実装済みの「ブース別コメント一覧GET」は本issueの対象外（§0）のため未変更。ブランチ `feat/admin-booth-sort`（base=`origin/feat/comment-api`、#54 の上に stack）。

## 実行コマンド

```bash
npm run build
npm test
```

## 環境

- ブランチ: `feat/admin-booth-sort`
- MySQL: 未使用（ユニットテストは DbClient モック。§7 の curl による live 統合検証は司令塔が別途実施）
- 関連 Issue: #55

## 結果

- `npm run build`: exit 0
- `npm test`: 7 ファイル・75件 ALL GREEN（新規 `admin-booth-sort.test.ts` 15件を含む）

## メモ

- ORDER BY は zod enum（`sort`/`order`）→ 定数マップ（`SORT_SQL`/`DIR_SQL`）の2段ホワイトリストのみで組み立て。リクエスト文字列は SQL に連結していない。`sort=DROP TABLE&order=x` でも 200・既定ソート（`checkin_count DESC, b.name ASC`）にフォールバックすることをテストで確認済み（SQL エラーにならない）。
- `avg_rating` は評価0件で `null`、あれば `Math.round(x*100)/100`。`checkin_count`/`comment_count` は `Number(x) || 0` で防御（DB がstring/null/undefinedを返す3パターンをテスト）。
- ページネーションは実装していない（設計 §3-2 のとおり全件返し。LIMIT/OFFSET のプレースホルダは今回未使用）。
- GET のみ `preHandler: [requireStaff, requireEventMatchesJwt]`。既存 POST/PATCH/DELETE の `requireManager` 系 `pre` は変更していない。viewer=200・participant=403・トークンなし=401・event_id 不一致=403 を確認。
- `git diff --stat` に comments 系ルート（`booth-comments.ts` 等）の変更はない（#54 の再実装なし・設計 §0 準拠）。
- §7 の curl による Docker 統合検証は 2026-07-12 に実施済み（ローカル Docker MySQL・sample-data 18ブース＋コメント7件投入）。結果:
  - デフォルト GET → 200・checkin_count 降順（先頭 22 件のブース）
  - `?sort=avg_rating&order=asc` → 昇順・評価なしブースが末尾
  - `?sort=name&order=asc` → 名前昇順
  - `?sort=DROP%20TABLE&order=x` → 200・既定ソート（SQLエラーなし＝ホワイトリスト有効）
  - `comment_count` 合計 = API 7 / DB `COUNT(comment)` 7 で一致
  - participant トークン → 403、トークンなし → 401（viewer=200 はユニット側で確認）
- デフォルトソート（`checkin_count desc`）と `comment_count` の is_hidden 含有方針は設計書 §9 で「要三上確認」と明記された運用判断のため、設計書の暫定値どおり実装した（今回のスコープ外）。
