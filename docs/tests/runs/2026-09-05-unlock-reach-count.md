# テスト実行記録 — 2026-09-05（解放到達人数の算出式に role 絞りを追加・issue #114）

`bingo.unlocks.{first,second,third}` の集計クエリに `users.role = 'participant'` の
絞りが無かった穴（設計書 F2）を塞いだ回の記録。設計は
`University/Research/02_コード/P3_2026/改修プラン/三上issue_2026-09/server_114_解放到達人数の算出式.md`。

## 何を

### 対象（src）

- `src/routes/v1/admin/dashboard.ts`（55-62 行のクエリに `JOIN users u ON u.id = k.user_id AND u.role = 'participant'` を追加。応答の形・フィールド名・しきい値は無改変）

### テストコード（tests）

- `tests/unit/admin-dashboard.test.ts`（T-20/T-21 を分割し、T-21 を到達人数側の SQL 文字列検証に変更。累積性のケース `first >= second >= third` を追加）

### 仕様（docs）

- `docs/specs/bingo-dynamic-unlock/06-api/admin-api.md`（算出式節に「累積」「SELF_HEAL を含む」の2文を追記）
- `docs/specs/recommender-phase-linkage/10-testing.md`（T-16〜T-21 を `[x]` に）
- `docs/specs/bingo-dynamic-unlock/00-must-do.md`（△2件の文言更新。到達人数の△は解消、分析除外の△は残す）

## なぜ

issue #114。`admin-api.md` の算出式節（F10）には既に `role = 'participant'` の絞りが
明記済みだったが、実装（`dashboard.ts`）だけがそれを欠いていた。出展者・運営スタッフの
試し操作が到達人数に混ざるのを防ぐ。

## 実行コマンド

```bash
npx vitest run tests/unit/admin-dashboard.test.ts --reporter=verbose
npm test
npm run build
```

## 環境

- ブランチ: `feat/unlock-reach-counts`（worktree、base = origin/develop = `564d3f5`）
- MySQL: 未使用（§7-2 のローカル docker 突合は未実行。理由: この作業環境に docker デーモンが
  起動しておらず `docker compose up -d mysql` が実行できない。`docker ps` は
  `dial unix .../docker.sock: connect: no such file or directory` で失敗する）
- 関連 PR / Issue: #114

## 結果

### §7-1 単体（実施済み）

`npx vitest run tests/unit/admin-dashboard.test.ts --reporter=verbose` → **10 件 pass**（T-12〜T-21、
うち T-20 と T-21 は別々の it として存在し、`first >= second >= third` の累積性ケースが 1 件ある）。

`npm test` → 34 ファイル中 32 pass（727 テスト中 696 pass・31 skip）。失敗した 2 ファイル
（`tests/integration/gacha/settings.test.ts` / `tests/integration/gacha/use-coin.test.ts`）は
いずれもローカル MySQL 接続エラーによるもので、今回の変更（`dashboard.ts` / 到達人数）とは
無関係な既存の docker 依存統合テスト（gacha）。`git diff --name-only origin/develop` に
gacha 関連ファイルは含まれない。

`npm run build` → exit 0。

### §7-2 データ突合（**未実行**）

ローカル docker（MySQL）が起動できない環境のため、manager ロールのカードに6ペア分の解放行を
直接挿入して before/after の `unlocks` が変化しないことを確かめる手順（設計書 §7-2）は
実行していない。単体テストはモック DB を使っており、`JOIN users u ... AND u.role = 'participant'`
の絞り込み効果そのものは実データでしか検証できない（設計書 F13）。**この突合は docker が
使える環境で改めて実行する必要がある。**

## メモ

- 次回（docker が使える環境）に §7-2 を実行し、この節を実測 JSON で更新すること。
- それまでは「実装は仕様どおりに書けている（SQL 文字列・ビルド・既存テストは pass）」ことは
  確認済みだが、「実データで絞り込みが機能する」ことは未確認のまま。
