---
状態: 確定
最終更新: 2026-08-24
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
  "recommender": {
    "current_phase": "DRSA",
    "decision_table_size": 176,
    "next_threshold": null,
    "remaining_to_next": 0
  },
  "unlocks": { "first": 98, "second": 76, "third": 61 },
  "fallback_rate_last_30min": 0.02
}
```

| 項目 | なぜ見るのか |
|---|---|
| `rating_collection_rate` | **推薦手法が成立するかどうかを左右する最重要指標**（[rating-collection.md](../04-rating/rating-collection.md)） |
| `current_phase` / `remaining_to_next` | いつ DRSA に切り替わるかを当日把握する |
| `unlocks` | 解放が1回目・2回目・3回目まで到達している人数。**離脱の把握** |
| `fallback_rate_last_30min` | 推薦サービスの障害検知。高ければ推薦エンジンが落ちている |

## GET /api/v1/admin/events/:event_id/analytics/recommendations（改修）

`recommendations` テーブルの廃止に伴い、`recommendation_scores` を読むように変更する。

- 推薦されたマスへの訪問率（フェーズ別・`interest_match` 別）
- 推薦されたが訪問されなかった件数（分母）
- カード外訪問の件数（対照群）

詳細な分析要件は
[07-research-logging/serendipity-data.md](../07-research-logging/serendipity-data.md)。
