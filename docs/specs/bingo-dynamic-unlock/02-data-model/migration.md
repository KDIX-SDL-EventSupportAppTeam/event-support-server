---
状態: 確定
最終更新: 2026-08-24
---

# マイグレーション

## 前提

**本番のさくら DB には、ビンゴ段階解放のマイグレーション（`09_bingo_staged_unlock.sql`）は
まだ適用されていない。** 入っているのはテスト用データのみで、消してよい。

→ **差分適用ではなく作り直しで進める。** 差分適用は途中で失敗したときの復旧が難しく、
本番前に取るべきリスクではない。

> **実行のタイミングに注意。作り直してよいが、すぐには実行しない。**
> 実装フェーズに入ってから、事前アンケート側の変更とまとめて1回で実行する。

## 方針

`db/migrations/09_bingo_staged_unlock.sql` を**書き換える**（新しい 10 を足さない）。
まだ本番に適用していないため、履歴として残す意味がない。

| ファイル | 変更 |
|---|---|
| `db/migrations/09_bingo_staged_unlock.sql` | 動的段階解放の内容へ全面的に書き換え |
| `db/create-tables.sql` | 同期。冒頭のテーブル一覧コメント・DROP セクション・確認手順のテーブル数を **21** に更新 |
| `src/scripts/db-check.ts` | `EXPECTED_TABLES` を 21 に、`EXPECTED_TABLE_NAMES` を更新 |

## 適用順序

DROP は参照先から参照元への逆順で行う。

1. `check_ins.cell_id` を NULL に落とす（`bingo_cells` への外部キーを外すため）
2. `DROP TABLE IF EXISTS recommendation_scores, card_unlock_events;`（作り直しの場合）
3. `DROP TABLE IF EXISTS cell_assignment_logs;` — `recommendation_scores` へ統合
4. `DROP TABLE IF EXISTS recommendations;` — **既存データごと削除**（[D-11](../01-concept/decisions.md)）
5. `DROP TABLE IF EXISTS bingo_cells, bingo_cards;`
6. `bingo_cards` → `bingo_cells` → `card_unlock_events` → `recommendation_scores` の順に作成
7. `gacha_coin_uses` を作成
8. 事前アンケート側の `event_app_access` を同じマイグレーションで作成する

## 事前アンケートと同時に行う

DB の作り直しは1回で済ませたい。以下を同じマイグレーションに含める。

- `event_app_access`（新規）
- `survey_questions.answer_type` の追加
- `user_survey_answers` への `UNIQUE (user_id, event_id)` 追加

詳細は [pre-survey](../../pre-survey/README.md) を参照。

## 適用後の確認

```bash
npm run db:check
```

`tables: 21` が返ること。主要テーブルの行数も表示されるので、
`recommendations` が消えていることを目視で確認する。

さくらへの引き渡し時は `db/create-tables.sql` を渡す
（先頭の `USE` を実 DB 名に書き換えて全文実行）。
