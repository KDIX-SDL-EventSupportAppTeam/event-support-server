# テスト実行記録 — 2026-08-25（ビンゴ動的段階解放の実装と検証）

2026-08-20 の仕様変更（中央4マス一括解放 → 中央2マスごとの逐次解放）と 08-24 の訂正を、
サーバー・フロント両方に実装した回の記録。実装・レビュー・性能計測・環境構築で出た問題を
すべて含む。

## 何を

### 対象（src）

新規・全面書き換え。

- `src/lib/bingo/unlockPairs.ts`（新規）— 中央ペア→開放列の対応表。DB・通信に触れない純関数
- `src/lib/bingo/phases.ts`（新規）— COVERAGE / SIMILARITY / DRSA の判定。純関数
- `src/lib/bingo/pickPreSurveyBooth.ts`（新規。`pickSignupBonusBooth.ts` を置換）
- `src/lib/bingo/unlock.ts` — `processCenterAchievement` / `healUnlockedCardIfNeeded`
- `src/lib/bingo/assignOuterCells.ts` — 推薦呼び出し・フォールバック・割当・スコア記録
- `src/lib/bingo/ensureCard.ts` / `assignCenterCell.ts` / `lines.ts` / `fallback.ts` / `recommenderClient.ts`
- `src/lib/app-access.ts`（新規）— アプリ公開ゲートの実効状態算出
- `src/routes/v1/bingo.ts` / `checkins.ts` / `admin/bingo.ts` / `admin/dashboard.ts`
- `src/routes/v1/app-access.ts` / `organizer/app-access.ts` / `admin/app-access.ts`（新規）
- `src/routes/v1/gacha.ts`（新規。器のみ）
- `src/routes/v1/survey.ts` — 関心分野を `categories` から動的配信
- `src/routes/v1/recommendations.ts`（削除）
- `db/migrations/09_bingo_staged_unlock.sql` / `db/create-tables.sql` / `src/scripts/db-check.ts`
- `src/scripts/seed-dev.ts` — ブース20件・カテゴリ4種へ拡充

### テストコード（tests）

- `tests/unit/bingo-unlock-pairs.test.ts`（新規、79 ケース。中央の埋まり順 65 通りを網羅）
- `tests/unit/bingo-phases.test.ts`（新規。しきい値の境界）
- `tests/unit/bingo-fallback.test.ts`（新規。訪問者数昇順の規則を固定）
- `tests/unit/app-access-resolve.test.ts` / `app-access-routes.test.ts`（新規）
- `tests/unit/bingo-unlock.test.ts` / `bingo-ensure-card.test.ts` / `bingo-lines.test.ts` /
  `bingo-assign-center-cell.test.ts` / `checkin-unlock.test.ts` / `admin-bingo-reassign.test.ts` /
  `survey.test.ts` — 新仕様へ全面追随

## なぜ

`docs/specs/bingo-dynamic-unlock/` と `docs/specs/pre-survey/` の実装。
旧方式（中央4マス完成→外周12マス一括解放、解放1回きり）から、
中央2マスが揃うたびにそのペアが乗るラインの外周2マスを解放する方式へ変更した。
解放は最大3回（新規成立ペア 1 / 2 / 3 組、開放マス 2 / 4 / 6）。

**注記**: 着手時点で両仕様書は「状態: 草案」だった。
`AGENTS.md` の「『状態: 確定』でない仕様は実装しない」に反するため、
実装前に明示の承認を得たうえで例外的に進めた。本記録の作成にあわせて状態を「実装済み」へ更新した。

## 実行コマンド

```bash
npm run build
npm test
npm run db:migrate      # 空 DB 用
npm run db:seed
npm run db:check
docker compose up -d mysql
```

## 結果

### ユニットテスト

`npm test` — 24 ファイル / **287 ケース 全通過**（実装前 271）。
`npm run build` — 通過。

フロント側（`event-support-frontend`）は 18 ファイル / **94 ケース 全通過**（実装前 85）、
`npm run lint` エラー 0、`npx tsc -b --noEmit` 通過。

### 実 API での通し確認

Docker Desktop + MySQL 8.0、シード投入済みの環境で、参加者アカウントから中央4マスを順にチェックイン。

| チェックイン | `unlocked_positions` | `unlocked_pairs` |
|---|---|---|
| 中央1マス目 | `[]` | `[]` |
| 中央2マス目 | `[4,7]` | `5-6` |
| 中央3マス目 | `[1,13,3,12]` | `5-9` / `6-9` |
| 中央4マス目 | `[8,11,2,14,0,15]` | `9-10` / `6-10` / `5-10` |

6ペア × 2マス = 外周12マス。`03-card-lifecycle/unlock-pairs.md` の対応表と一致。

### SQL 往復数

本番はさくらプロキシ経由で 1 リクエスト = 1 SQL（[ADR 0001](../../decisions/adrs/0001-sakura-proxy-error-masking.md)）のため、
往復数がそのまま応答時間になる。`SHOW GLOBAL STATUS LIKE 'Questions'` の差分で計測。

| ケース | 最適化前 | 最適化後 |
|---|---|---|
| チェックイン（解放なし） | 17 | 17 |
| チェックイン（解放1ペア） | 39 | **30** |
| チェックイン（解放2ペア） | 43 | **31** |
| チェックイン（解放3ペア） | 47 | **33** |
| カード取得（解放後） | 9 | **6** |

**1往復 50ms と仮定すると、解放3回目のチェックインは約 1.65 秒。**
ローカル直結では 44〜105ms に収まるため、この数字はローカルでは再現しない。
本番相当の経路での負荷試験が必要（[00-must-do.md](../../specs/bingo-dynamic-unlock/00-must-do.md)）。

### 自己修復の同時実行

`GET /events/:event_id/bingo/card` を 10 並列 × 3 ラウンド実行し、**全 200**。
最適化前は `recommendation_scores` の重複キーで 500 になる経路があった。
ただし完全同時実行は塞げていない（後述）。

### フォールバック規則

`RECOMMENDER_URL` 未設定の状態で解放させ、割り当てられたブースの訪問者数を確認。
すべて 0〜1 で、**訪問者数の少ない順が維持されている**（人気順になっていない）。
`card_unlock_events.strategy` は `FALLBACK_COVERAGE`、`phase` は `COVERAGE`。
[05-recommender/contract.md](../../specs/bingo-dynamic-unlock/05-recommender/contract.md) の
「推薦エンジン未実装でもフォールバックが常に走る状態で正常に動くこと」を満たす。

### `recommendation_scores` の記録

解放イベントごとに 18 / 15 / 15 行、`was_assigned` は各 2。
複数ペアを 1 回の INSERT にまとめても、イベントごとの候補全件記録は保たれている。

## 実装後に発見して修正した問題

### 正確性

| 問題 | 影響 |
|---|---|
| チェックインのレスポンスから `pair_key` を復元できず、**2回目・3回目の解放で演出が出なかった** | 3回ある解放のうち2回で演出が欠落。`unlocked_pairs` を追加して解決 |
| 解放済みだが未訪問のマスを `visited_booths` に含めていた | 推薦の算出と研究データの両方を汚染 |
| `pre_survey` を DB の行のまま入れ子で送っていた | 関心分野が推薦に渡らず、しかもフォールバックには落ちないため無言で選好を無視 |
| 自己修復の同時実行で重複キー → 500 | カード取得が落ちる。INSERT 前の存在確認を追加 |
| 同じ解放演出の二重再生 | 再生済みフラグがキュー投入時点で未書き込みのため |
| 解放演出が評価ステップより先に再生 | `03-checkin-flow.md` の順序と逆。評価回収率を下げる |
| 事前推薦マスを手動評価できない | NEXT_CHECKIN 方式で取り逃す最後の1件が回収不能 |
| 候補不足のマスが真っ白でクリック可能 | 不具合と区別がつかない |

### マイグレーション

`09_bingo_staged_unlock.sql` が **新規 DB で中断していた**。
`check_ins.cell_id` を、同じファイルの後段で追加するより前に UPDATE していたため、
01〜08 だけを適用した DB では `ERROR 1054: Unknown column 'cell_id'` で停止し、
**ビンゴ関連テーブルが1つも作られない**状態だった。
ファイル冒頭が指定する Docker init 経路そのものが通っていなかった。列の存在確認を挟んで修正。

あわせて `src/scripts/db-migrate.ts` の期待テーブル数が 18 のままで、
マイグレーション成功後に必ず失敗する状態だったため 20 へ修正。

### シード

- `event_app_access` の行を作っておらず、行の無いイベントは `closed` 相当として扱われるため
  **参加者が `/home` に入れなかった**
- 関心分野の設問に `question_key='interest_categories'` が無く、
  `custom_answers.interest_categories` が入らないため**事前推薦マスが永久に空**だった
- ブース3件では16マスのカードが埋まらないため **20件**へ、カテゴリも **4種**へ拡充

### 開発環境

`localhost` の名前解決で **全 API が一律 210ms を払っていた**。
Windows が先に IPv6（`::1`）を試すのに対し、サーバーは `0.0.0.0`（IPv4のみ）で待ち受けているため。

| 接続先 | TCP接続 | 合計 |
|---|---|---|
| `localhost:3000` | 210 ms | 219 ms |
| `127.0.0.1:3000` | 1 ms | 5.7 ms |

フロントの `.env.example` を `127.0.0.1` へ修正。
根治するならサーバーをデュアルスタック（`::`）で待ち受けさせるが、
Cloud Run への影響確認が要るため未実施。

## 残っている限界

- **自己修復の完全同時実行は塞げていない。** 両リクエストが揃って INSERT 前の存在確認を終える瞬間は、
  トランザクション無しでは原理的に閉じられない（`card_unlock_events` の権利取得と同じ割り切り、ADR 0001）。
  10 並列テストで再現しない程度には狭いが、当日の同時アクセス下では確率が上がる
- **運営によるブース差し替えを `recommendation_scores` に記録できない。**
  `unlock_event_id` が NOT NULL の外部キーで、差し替えには対応する解放イベントが無い。
  現在は `audit_logs` にのみ記録。テーブル定義の変更が必要
- **事前推薦マスの `recommendation_scores` は選ばれた1件のみ。**
  `pickPreSurveyBooth` が候補全件をスコアリングしないため、D-10 の「全候補」に未達
- 推薦エンジン本体（`event-support-recommend`）は未着手。
  現在はフォールバックのみが動作しており、**DRSA による推薦は一切効いていない**

## 関連

- 仕様: [docs/specs/bingo-dynamic-unlock/](../../specs/bingo-dynamic-unlock/README.md)
- 仕様: [docs/specs/pre-survey/](../../specs/pre-survey/README.md)
- 残作業: [00-must-do.md](../../specs/bingo-dynamic-unlock/00-must-do.md)
- 未決定: [09-open-questions/open-questions.md](../../specs/bingo-dynamic-unlock/09-open-questions/open-questions.md)
- 議事録: [2026-08-20 ビンゴ仕様変更](../../decisions/meetings/2026-08-20-bingo-spec-change.md)
