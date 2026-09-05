---
状態: 実装済み
最終更新: 2026-09-05
---

# 運営向け API

## PATCH /api/v1/events/:event_id/admin/booths/:booth_id/active

ブースの当日中止・復帰。既存のまま。`is_active = 0` にしたブースは推薦候補から外れる。

## POST /api/v1/events/:event_id/admin/bingo/reassign

中止したブースが、既に見えているマスに載っている参加者を救済する。

```json
// リクエスト
{ "booth_id": "…" }
// レスポンス
{ "affected_cards": 12, "reassigned_cells": 12, "cleared_cells": 0 }
```

処理:

1. `is_revealed = 1 AND is_achieved = 0 AND booth_id = ?` のマスを全カードから探す
2. 各マスについてフォールバック規則で代替ブースを選び、差し替える
3. 代替が見つからないマスは `booth_id = NULL` にする（`is_revealed = 1` のまま）
4. `recommendation_scores` に `strategy='REASSIGN'` で記録する

**達成済み（`is_achieved = 1`）のマスは触らない。** 参加者は既に訪問しており、
取り消すと体験が壊れる。

## GET /api/v1/admin/events/:event_id/dashboard（拡張）

当日の運営監視に、以下を追加する。

```json
{
  "checkins": 412,
  "ratings": 176,
  "rating_collection_rate": 0.427,
  "unlocks": { "first": 98, "second": 76, "third": 61 },
  "fallback_rate_last_30min": 0.02
}
```

**フェーズ情報（`current_phase` など）はこの応答に含めない。**
サーバーは自分でフェーズを計算しない（`determinePhase(評価件数)` は推薦エンジンの
実際の稼働フェーズと食い違いうる）。推薦エンジンの稼働状態は中継エンドポイント
[GET /api/v1/admin/events/:event_id/recommender/state](../../recommender-phase-linkage/01-ops-state-relay.md)
が返す。この応答が返すのは **DB の事実だけ**。

| 項目 | なぜ見るのか |
|---|---|
| `rating_collection_rate` | **推薦手法が成立するかどうかを左右する最重要指標**（[rating-collection.md](../04-rating/rating-collection.md)） |
| `unlocks` | 解放が1回目・2回目・3回目まで到達している人数。**離脱の把握** |
| `fallback_rate_last_30min` | 推薦サービスの障害検知。高ければ推薦エンジンが落ちている |

### `unlocks` の算出式

カードごとに、`card_unlock_events` の行数（**`pair_key = 'PRESURVEY'` を除く**、
`role = 'participant'` のカードのみ）から累計成立ペア数を求める。
中央マスが 2 / 3 / 4 個埋まった時点で成立ペアが累計 1 / 3 / 6 組になる
（[unlock-pairs.md](../03-card-lifecycle/unlock-pairs.md) の対応表）。

| 表示 | 条件 | 意味 |
|---|---|---|
| `unlocks.first` | 累計ペア数 >= 1 | 中央2マスが埋まった |
| `unlocks.second` | 累計ペア数 >= 3 | 中央3マスが埋まった（2組同時成立） |
| `unlocks.third` | 累計ペア数 >= 6 | 中央4マスすべてが埋まった |

`pair_key = 'PRESURVEY'`（事前推薦マス）は解放ではないので数えない。

- 人数は**累積**で数える。3 回目まで到達したカードは 1 回目・2 回目にも数えられるため、常に
  `first >= second >= third`。「2 回目で止まっている人数」は `second - third` で読む。
- 数える対象は `card_unlock_events` の行（`strategy` が `RECOMMEND` / `FALLBACK_COVERAGE` / `SELF_HEAL` のいずれでも数える。
  自己修復で成立した解放も解放である）。`bingo_cells` の状態からは逆算しない。

## GET /api/v1/admin/events/:event_id/analytics/recommendations（改修）

`recommendations` テーブルの廃止に伴い、`recommendation_scores` を読むように変更する。

- 推薦されたマスへの訪問率（フェーズ別・`interest_match` 別）
- 推薦されたが訪問されなかった件数（分母）
- カード外訪問の件数（対照群）

詳細な分析要件は
[07-research-logging/serendipity-data.md](../07-research-logging/serendipity-data.md)。
