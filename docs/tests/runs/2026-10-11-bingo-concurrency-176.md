# テスト実行記録 — 2026-10-11 ビンゴの並行処理の再現確認と小修正（#176）

## 何を

### 対象（src）

- `src/routes/v1/checkins.ts`（中央マスの後出し割当を `assignCenterCell` に置き換え）
- `src/lib/bingo/assignOuterCells.ts`（推薦応答の `scores` 重複を畳む）
- 再現確認のみ（変更なし）: `src/lib/bingo/unlock.ts`（`healUnlockedCardIfNeeded` / `processCenterAchievement`）, `src/routes/v1/bingo.ts`

### テストコード（tests）

- `tests/integration/bingo-concurrency/harness.ts`（共通。mock プロキシを子プロセスで起動）
- `tests/integration/bingo-concurrency/repro.test.ts`（再現確認。`RUN_BINGO_CONCURRENCY_REPRO=1` のときだけ実行。数分かかる）
- `tests/integration/bingo-concurrency/regression.test.ts`（修正した 2 件の回帰テスト。通常の `npm test` で実行）

## なぜ

#176。コードレビューで挙がった 4 つの懸念を、本番と同じ条件（`src/scripts/sakura-proxy-mock.ts` 経由＝1 リクエスト 1 SQL・DB エラーは 500 に潰れる・数値は文字列で届く）で再現するか確認する。

## 実行コマンド

```bash
docker compose up -d mysql
# db/migrations/ を最新まで適用した DB を使うこと（古い DB だと no_candidate_reason 列が無く、カード取得が 500 になる）
export DATABASE_URL=mysql://app:appsecret@127.0.0.1:3306/event_support_176
RUN_BINGO_CONCURRENCY_REPRO=1 ROUNDS=40 npx vitest run tests/integration/bingo-concurrency/repro.test.ts
npx vitest run tests/integration/bingo-concurrency/regression.test.ts
npm test
npx tsc --noEmit
```

## 環境

- ブランチ: `test/176-bingo-concurrency`
- MySQL: docker compose の mysql:8.0。検証用に別 DB `event_support_176` を作り、`db/migrations/*.sql` を番号順に全適用
- 推薦サービス: なし（フォールバックのみ）／偽物（応答を 150ms 遅らせ、候補を昇順の先頭から返す決定的な実装）の 2 通り
- 1 シナリオ 40 ラウンド。ラウンドごとに新規ユーザー・新規カード
- 関連 Issue: #176

## 結果（修正前の再現）

シナリオ:
- S1: 解放を起こすチェックイン POST の最中に、同じユーザーが `GET /bingo/card`（自己修復）を 15ms おきに撃ち続ける
- S2: 同じユーザーが別ブースへ 2 件のチェックインをほぼ同時に送る（2 本目を d ms 遅らせる。オフライン同期の並列送信を想定）
- S4: 推薦の応答の `scores` に同じブースが重複

| 懸念 | 結果 | 根拠（修正前・40 ラウンド中） |
|---|---|---|
| ① 自己修復×解放で外周マスが二重割当／研究データ不整合 | **再現した**（形は「二重割当」ではなく「500＋記録の不一致」） | S1/推薦なし: 500 が 29 件、解放が公開されないまま残るカード 7、`strategy` が `PENDING` のまま 15、`recommendation_scores` の `was_assigned=1` とカード上のブースが食い違う解放 11。S1/150ms: 500 が 35 件、食い違い 5。同じブースが 2 マスに載ることは **0**（`uq_cell_card_booth` が弾くため、代わりに UPDATE が失敗して 500 になる） |
| ② 別ペアの同時解放で同じブースが 2 マス／500 | **再現した** | S2/150ms で 2 本目を 10ms・40ms 遅らせると 40 ラウンド中 39〜40 で 500。公開されない外周マスが残り `PENDING` のまま。重複ブースは 0（①と同じ理由）。いずれも次の `GET /bingo/card` の自己修復で全件回復（修復後に未公開・`PENDING`・食い違いはすべて 0） |
| ③ 中央マス割当が競合に負けても再試行しない | **再現した（最も深刻）** | S2/d0 で 40/40 ラウンド（推薦なし・150ms の両方）、負けた側のチェックインは `filled_cell: null` の 200 で返り、`check_ins` は残るが中央マスが空のまま。同じブースへ再チェックインは 409 になるため、**自己修復でも救えず永久に取りこぼす** |
| ④ 推薦応答のブース重複で 500 | **再現した**（`assigned` ではなく `scores` の重複） | S4: 5 ラウンドで 15 件の 500。マスは公開済みなのに解放が `PENDING` のまま、記録も食い違う。`assigned` の重複は既存の `seen` で弾かれており問題なし |

## 結果（修正後）

| 懸念 | 対応 | 結果（修正後・40 ラウンド中） |
|---|---|---|
| ③ | **修正**: `checkins.ts` の分岐 2 を既存の `assignCenterCell`（取り直して最大 3 回再試行）に置き換え | 中央マスが空のまま 0・`cell_id` が空のチェックイン 0（全シナリオ） |
| ④ | **修正**: `assignOuterCells.ts` で `scores` を `booth_id` で畳む | S4: 500 が 0、`PENDING` 0、食い違い 0 |
| ①② | **修正せず（大きい）** | 変化なし。下記「要判断」 |

- 回帰テスト `regression.test.ts` は修正前に 2 件とも失敗、修正後は通過。負荷をかけた状態で 14 回連続通過。
- `npm test`: 935 件通過・9 件スキップ（`repro.test.ts`）。`tests/unit/socket-logging.test.ts` のみ `socket.io-client` 未インストールでロード失敗（本件と無関係）。

## ①② を修正しなかった理由（要判断）

- 原因は `assignOuterCellsForPairs` に相互排他が無いこと。複数のリクエストが同じ除外集合から同じブースを選び、`UPDATE bingo_cells`（1 文で全マス更新）が `uq_cell_card_booth` で丸ごと失敗する。直すには「マス単位で先に権利を取る」か「失敗時に勝者の状態を読み直して記録を書かない」など、`assignOuterCells.ts` 全体（スコア記録・メタ更新を含む約 500 行の中核）の組み替えが要る。
- 案 A: プロセス内のカード単位ミューテックス。小さいが、「排他は DB の条件付き UPDATE」という原則（AGENTS.md）と違い、Cloud Run が 1 インスタンス前提（ADR 0002）に依存する。
- 案 B: 失敗を握りつぶして 200 を返し、次の GET の自己修復に任せる。500 は消えるが、その場の解放演出（`unlocked_positions`）が出ない。
- ③を直したことで、同時チェックインの 2 件目も解放まで進むようになり、②の 500 に当たる確率が上がる（S2/推薦なし/d0 で修正前 0 → 修正後 13/80 リクエスト）。ただしチェックインと中央マスは保存済みで、次の GET で回復する（修復後の食い違いは 0）。永久に取りこぼす③より軽い。
- 実機でこの並列送信が起きるか（フロントがオフライン分を並列で送るか）は**未確認**。

## 当日の点検手順案（①②が起きたかを運営が確認する。読み取りのみ）

```sql
-- 1. 解放済みなのに公開されていない外周マス（あれば、そのユーザーが一度カードを開けば自己修復される）
SELECT bc.card_id, cue.pair_key, bc.position
  FROM card_unlock_events cue
  JOIN bingo_cells bc ON bc.card_id = cue.card_id AND bc.zone = 'OUTER' AND bc.is_revealed = 0
                     AND NOT (bc.source = 'NO_CANDIDATE' AND bc.is_achieved = 1)
                     AND FIND_IN_SET(bc.position, cue.released_positions)
 WHERE cue.pair_key <> 'PRESURVEY';

-- 2. 5 分以上 PENDING のままの解放イベント
SELECT card_id, pair_key, created_at FROM card_unlock_events
 WHERE pair_key <> 'PRESURVEY' AND strategy = 'PENDING' AND created_at < UTC_TIMESTAMP() - INTERVAL 5 MINUTE;

-- 3. 記録（was_assigned=1）とカード上のブース数が合わない解放イベント（研究データの不整合）
SELECT cue.id, cue.card_id, cue.pair_key FROM card_unlock_events cue
 WHERE cue.pair_key <> 'PRESURVEY' AND cue.strategy <> 'PENDING'
   AND (SELECT COUNT(*) FROM recommendation_scores rs WHERE rs.unlock_event_id = cue.id AND rs.was_assigned = 1)
    <> (SELECT COUNT(*) FROM bingo_cells bc WHERE bc.card_id = cue.card_id AND bc.booth_id IS NOT NULL
                                              AND FIND_IN_SET(bc.position, cue.released_positions));

-- 4. 中央マスが空なのにカード外扱いのチェックインがあるカード（③の取りこぼし。修正前のデータ向け）
SELECT c.id AS card_id, c.user_id FROM bingo_cards c
 WHERE EXISTS (SELECT 1 FROM bingo_cells bc WHERE bc.card_id = c.id AND bc.zone = 'CENTER' AND bc.booth_id IS NULL)
   AND EXISTS (SELECT 1 FROM check_ins ci WHERE ci.user_id = c.user_id AND ci.event_id = c.event_id AND ci.cell_id IS NULL);
```

4 本のクエリは検証用 DB で構文が通ることだけ確認した（該当データが無いため結果は空）。本番での実行は未確認。

## メモ

- 偽の推薦サービスは決定的に先頭から返すため、同じ入力の 2 リクエストが必ず同じブースを選ぶ。実際の推薦エンジンでの衝突率は**未確認**（フォールバックのみでも再現はした）。
- `docs/tests/README.md` の記録一覧への追記は他 PR との衝突回避のため未実施。
- `db/migrations/` を最新まで適用していないローカル DB では、ビンゴ系の結合テストが失敗する（`no_candidate_reason` 列なし）。
