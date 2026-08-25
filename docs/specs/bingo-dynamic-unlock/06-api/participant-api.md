---
状態: 実装済み
最終更新: 2026-08-25
---

# 参加者向け API

**このファイルが API 契約の正本である。** フロントはここを参照し、内容をコピーしない。
共通のレスポンス封筒は `{ ok: true, data: {...} }` / `{ ok: false, error: { code, message } }`。

## GET /api/v1/events/:event_id/bingo/card

カードを取得する。無ければ生成する（[signup.md](../03-card-lifecycle/signup.md)）。
自己修復もここで走る（[fallback.md](../05-recommender/fallback.md)）。

```json
{
  "card_id": "…",
  "rating_scale": 4,
  "progress": {
    "center_achieved": 2,
    "center_total": 4,
    "revealed_cells": 6,
    "achieved_cells": 2
  },
  "lines_completed": 0,
  "unlock_events": [
    { "pair_key": "5-6", "released_positions": [4, 7], "unlocked_at": "2026-10-16T04:12:00.000Z" }
  ],
  "cells": [
    {
      "position": 0,
      "zone": "OUTER",
      "is_revealed": false,
      "is_achieved": false,
      "source": null,
      "booth": null
    },
    {
      "position": 5,
      "zone": "CENTER",
      "is_revealed": true,
      "is_achieved": false,
      "source": "PRESURVEY",
      "booth": { "id": "…", "name": "…", "manual_code": "…", "description": "…" }
    }
  ]
}
```

### 必ず守ること

- `cells` は **position 昇順で必ず16件**
- **`is_revealed: false` のマスでは `booth` を必ず `null` にする。**
  解放前に中身を漏らさない。これは絶対の制約
- `coins` は返さない。ライン数だけを返す（[D-5](../01-concept/decisions.md)）
- `status` は返さない。カードの段階は保存していない（[D-8](../01-concept/decisions.md)）
- `reason` は返さない（[D-6](../01-concept/decisions.md)）。**ブース説明 `description` は返す**
- `unlock_events` は解放済みのペアを時刻順に。フロントは演出の再生済み判定に使う

## POST /api/v1/events/:event_id/checkins

```json
// リクエスト
{ "method": "qr", "booth_id": "…", "checked_in_at": "2026-10-16T04:12:00.000Z" }
{ "method": "manual", "manual_code": "A1B2C3", "checked_in_at": "…" }
```

```json
// レスポンス
{
  "checkin_id": "…",
  "booth": { "id": "…", "name": "…" },
  "synced_at": "…Z",
  "cooldown_remaining_sec": 0,
  "filled_cell": { "position": 6 },
  "unlocked_positions": [1, 13, 3, 12],
  "unlocked_pairs": [
    { "pair_key": "5-9", "released_positions": [1, 13] },
    { "pair_key": "6-9", "released_positions": [3, 12] }
  ],
  "new_lines": 0,
  "lines_completed": 0,
  "pending_rating": { "checkin_id": "…", "booth_id": "…", "booth_name": "…" }
}
```

| フィールド | 説明 |
|---|---|
| `filled_cell` | 今回のチェックインで埋まったマス。カード外訪問なら `null` |
| `unlocked_positions` | **今回の解放で開放された外周 position の配列。** 解放が起きなければ空配列 |
| `unlocked_pairs` | 同じ解放の**ペア単位の内訳**（`pair_key` と、そのペアで開放された position）。解放が起きなければ空配列 |
| `new_lines` | 今回のチェックインで新たに成立したライン数 |
| `lines_completed` | 成立ライン数の合計 |
| `pending_rating` | 未回収の評価があれば非 `null`（[rating-collection.md](../04-rating/rating-collection.md)） |

- `unlocked` という真偽値は**返さない。** 解放が複数回あるため、開放されたマスの配列を返す
- `coins_earned` は返さない（[D-5](../01-concept/decisions.md)）
- 中央3マス目・4マス目の達成では2ペア・3ペアが同時に成立し、`unlocked_positions` には
  全ペア分が平坦に混ざる。**ペア単位の解放演出には `unlocked_pairs` を使うこと。**
  対応表（[unlock-pairs.md](../03-card-lifecycle/unlock-pairs.md)）をフロントで複製して
  逆引きしてはならない（正本はサーバー）

### エラー

| 状況 | ステータス | コード |
|---|---|---|
| 同じブースへの2回目 | 409 | `CONFLICT` |
| 存在しないブース / 手動コード | 404 | `NOT_FOUND` |
| 入力不正 | 422 | `VALIDATION_ERROR` |
| クールタイム中（既定では発生しない） | 429 | `COOLDOWN` |

## POST /api/v1/events/:event_id/checkins/:checkin_id/rating

```json
{ "rating": 3, "comment": "任意", "context": "NEXT_CHECKIN" }
→ { "rating_id": "…" }
```

- `rating` は `1 <= rating <= RATING_SCALE`（既定 4）。範囲外は 422
- `context` は `NEXT_CHECKIN` / `MANUAL`。省略時は `MANUAL`
- コメントは空文字・空白のみなら `NULL` に正規化する
- 同じ `checkin_id` への2回目は 409

## GET /api/v1/events/:event_id/gacha/coins

**器だけ用意する。ガチャ本体は後から実装する**（[D-5](../01-concept/decisions.md)）。

```json
{ "lines_completed": 2, "earned": 2, "used": 0, "available": 2, "max": 4 }
```

ビンゴ側から `lines_completed` を読み、ガチャ側が枚数へ換算する。
**ビンゴのモジュールはこのエンドポイントを知らない。**

## POST /api/v1/events/:event_id/gacha/coins/use

**器だけ用意する。** `gacha_coin_uses` に1行 INSERT し、残枚数を返す。

## 削除するエンドポイント

- `GET /api/v1/events/:event_id/recommendations`
- `POST /api/v1/events/:event_id/recommendations/:recommendation_id/select`

旧「推薦欄」方式のもの。**推薦を外部 UI に切り出さない**という制約に反する
（[D-11](../01-concept/decisions.md)）。フロントの `CheckInRecommendView` も削除する。

## socket.io

| room | イベント | payload |
|---|---|---|
| `event:{event_id}:user:{user_id}` | `bingo:unlocked` | `{ unlock_event_ids: [...], released_positions: [1,13,3,12], unlocked_pairs: [{ pair_key: "5-9", released_positions: [1,13] }], unlocked_at: "…Z" }` |
| `event:{event_id}:admin` | `checkin:new` | `{ booth_id, booth_name, user_display_name, checked_in_at }` |
| `event:{event_id}:admin` | `rating:new` | `{ booth_id, booth_name, rating, comment, user_display_name }` |

**`bingo:unlocked` は副経路である。** 正の経路はチェックインレスポンスの `unlocked_positions`。
スマホをポケットに入れる・別アプリを開くなどで接続は簡単に切れるため、
socket に依存した設計にしない。
