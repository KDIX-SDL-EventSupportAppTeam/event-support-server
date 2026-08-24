# 推薦サービスとの契約

外側12マスのブースを決める推薦マイクロサービス（Python FastAPI）との API 契約。
**アルゴリズム本体は本仕様書のスコープ外**（[09-open-questions](../09-open-questions/open-questions.md) Q-3）。**呼び出し口だけ作り、中身はフォールバック相当のスタブでよい。**

## エンドポイント

```
POST {RECOMMENDER_URL}/recommend/outer-cells
```

`RECOMMENDER_URL` は既存の環境変数。**未設定・空文字なら呼び出さず即フォールバックする**（既存の `recommendations.ts` と同じ扱い）。

## リクエスト

```json
{
  "event_id": "…",
  "user_id": "…",
  "visited_booths": [
    { "booth_id": "…", "order": 0, "source": "SIGNUP_BONUS", "rating": null },
    { "booth_id": "…", "order": 1, "source": "FREE_VISIT", "rating": 3 },
    { "booth_id": "…", "order": 2, "source": "FREE_VISIT", "rating": 2 },
    { "booth_id": "…", "order": 3, "source": "FREE_VISIT", "rating": null }
  ],
  "rating_scale": 3,
  "pre_survey": { "…": "…" } ,
  "exclude_booth_ids": ["…"],
  "cell_count": 12
}
```

- `visited_booths` は**参加ボーナスを含む**。`source` で区別できるようにしてある（ボーナスは本人の選好ではないので、推薦側で重み 0 にする判断ができる）
- `rating` は未評価なら `null`。**0〜3件しか付かないことを前提にする**
- `pre_survey` は未回答なら `null` または空オブジェクト。**未回答でも 200 を返せること**
- `rating_scale` を渡すのは、途中で段階数を変えても推薦側が正規化できるようにするため

## レスポンス

```json
{
  "cells": [
    { "booth_id": "…", "strategy": "PURE", "score": 0.82, "reason": { "…": "…" } }
  ]
}
```

- `cells` は最大 `cell_count` 件。**足りなくてもよい**（サーバー側がフォールバックで補完する）
- `strategy` は VARCHAR。将来 `PURE` / `SERENDIPITY` / `RANDOM` 等を取りうる想定。**サーバーは値を検証せずそのまま `cell_assignment_logs.strategy` に保存する**
- `reason` は自由な JSON。そのまま `cell_assignment_logs.reason_payload` に保存し、理由文生成に使う。**サーバーは中身を解釈しない**

## 呼び出し側の実装要件

| 要件 | 内容 |
|---|---|
| タイムアウト | `RECOMMENDER_TIMEOUT_MS`（既定 **1500**）で `AbortController` により中断 |
| 失敗時 | 例外を上げず[フォールバック](fallback.md)へ。**解放処理そのものは必ず成功させる** |
| 重複除去 | 返却された `booth_id` の重複・`exclude_booth_ids` との重複を除去する。推薦側を信用しない |
| 不足補完 | 12件に満たない分をフォールバック規則で補い、その分だけ `strategy='FALLBACK_COVERAGE'` で記録する |
| 検証 | 存在しない `booth_id` / `is_active=0` のブースは捨てる |

**推薦サービスの応答を検証せずにそのまま DB へ書かないこと。**`bingo_cells` の `UNIQUE (card_id, booth_id)` に当たって解放処理全体が失敗するのが最悪のケースである。

## スタブ実装

Python 側が未実装の間は、**サーバー側でフォールバックが常に走る状態で正常に動く**こと。`RECOMMENDER_URL` 未設定のまま結合テストが通ることを確認する。
