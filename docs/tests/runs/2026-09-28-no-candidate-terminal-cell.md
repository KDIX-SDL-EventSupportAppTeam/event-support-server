# テスト実行記録 — 2026-09-28（割当可能なブースが0件のマスを終端状態にする / issue #150）

## 何を

### 対象（src）

- `src/lib/bingo/assignOuterCells.ts`（終端状態の書き込み・`ALL_VISITED` / `INSUFFICIENT_BOOTHS` の判定）
- `src/lib/bingo/unlock.ts`（`noCandidateCells` の返却・自己修復の除外）
- `src/routes/v1/bingo.ts`（`no_candidate_reason` の返却）
- `src/routes/v1/checkins.ts`（`no_candidate_cells` の返却・ライン計算の位置）
- `card_unlock_events.strategy` の `'NO_CANDIDATE'`（`src/routes/v1/admin/dashboard.ts` のフォールバック率を汚さないため）
- `db/migrations/19_bingo_cell_no_candidate.sql` / `db/create-tables.sql`

### テストコード（tests）

- `tests/unit/bingo-unlock.test.ts`（「割当可能なブースが0件のマス（issue #150）」を追加、E7 のケースを更新）
- `tests/unit/checkin-unlock.test.ts`（チェックインレスポンスと1回だけのライン計算）
- `tests/unit/bingo-card-no-candidate.test.ts`（新規。`GET /bingo/card` のレスポンス契約）

## なぜ

issue #150。事前推薦マスを最後まで残して他の全ブースを訪問すると、解放された6マスが
「候補が0件」で空白のまま `is_achieved = 0` で残り、参加者から見て行けないマスになる。
確定した方針（issue のコメント）は「その場で終端状態にする」「全制覇とブース数不足を区別して返す」
「この経路では推薦サービスを呼ばず `recommendation_scores` にも行を作らない」。

コメントの「テストで固定すること」7項目をすべてテストにした。

| 固定する項目 | テスト |
|---|---|
| 未訪問の有効ブースが0件 → `is_achieved = 1` の終端状態 | `bingo-unlock.test.ts`「未訪問の有効ブースが0件なら…（ALL_VISITED）」 |
| 有効ブースが16未満 → 埋まらないマスが `is_achieved = 1` | 同「有効ブースが16未満のイベントでは…」 |
| 2状態が区別してレスポンスに現れる | 同「全制覇とブース数不足は区別され、混ざらない」＋ `bingo-card-no-candidate.test.ts` ＋ `checkin-unlock.test.ts` |
| 推薦サービスが呼ばれない | 同「この経路では推薦サービスを呼ばない」 |
| `recommendation_scores` に行が作られない | 同「この経路では recommendation_scores に行を作らない」 |
| 6マス同時でライン計算が1回・本数が正しい | 同「6マス同時のとき…」＋ `checkin-unlock.test.ts`「…ライン計算を1回だけ走らせる」 |
| 自己修復が終端状態のマスを埋め直さない | 同「自己修復は終端状態のマスを埋め直さない」「…is_revealed=0 に巻き戻っていても…」＋ `bingo-card-no-candidate.test.ts` |

## 実行コマンド

```bash
npm test
npm run build
```

`npm run lint` は**このリポジトリに存在しない**（`package.json` に `lint` スクリプトが無い）。
型検査は `npm run build`（`tsc -p tsconfig.build.json`）が担っており、本テンプレートの
実行コマンド欄もその2本になっている。

## 環境

- ブランチ: `fix/150-no-candidate-terminal-cell`
- MySQL: 未使用（すべてインメモリのフェイク DB）
- 関連 PR / Issue: #150 / frontend#152

## 結果

- `npm test`: 47 ファイル / 866 テスト すべて成功
- `npm run build`: エラーなし
- マイグレーション `19_bingo_cell_no_candidate.sql` は未適用（DDL のみ。適用は手元 DB / 本番手順に従う）

## メモ

- `bingo-unlock.test.ts` の E22（解放の同時実行）はフェイク DB の await 回数に依存している。
  今回追加した `countUnvisitedActiveBooths` の `await` は**埋められないマスが出るときだけ**走るため
  （`&&` の短絡）、候補が足りている E22 のシナリオでは await 回数が変わらない。
- `no_candidate_reason` は**割当時点の凍結値**である。運営があとからブースを追加しても書き換えない。
  導出にしなかった理由は `03-card-lifecycle/unlock.md` に書いた。
- 1マスも埋められなかったペアの `card_unlock_events.strategy` を `'NO_CANDIDATE'` にした。
  issue の指示には無い判断。`'FALLBACK_COVERAGE'` のままだと `dashboard.ts` の
  「直近30分のフォールバック率」が全制覇で跳ね、障害の指標として読めなくなるため。
- フロント側の表示出し分けは frontend#152。レスポンスの契約は
  `docs/specs/bingo-dynamic-unlock/06-api/participant-api.md`「終端状態のマス」が正本。
