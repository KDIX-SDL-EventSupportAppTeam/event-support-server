---
状態: 実装済み
最終更新: 2026-09-28
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
      "no_candidate_reason": null,
      "booth": { "id": "…", "name": "…", "display_code": "A-12", "description": "…" }
    },
    {
      "position": 7,
      "zone": "OUTER",
      "is_revealed": true,
      "is_achieved": true,
      "source": "NO_CANDIDATE",
      "no_candidate_reason": "ALL_VISITED",
      "booth": null
    }
  ]
}
```

### 終端状態のマス（`source = "NO_CANDIDATE"`）

解放時に**割当可能なブースが0件**で、ブースを載せられなかったマス（issue #150 /
[E7](../08-edge-cases/edge-cases.md) / [unlock.md](../03-card-lifecycle/unlock.md)）。
`is_revealed: true`・`is_achieved: true`・`booth: null` で確定し、以後変化しない。
理由は `no_candidate_reason` で区別する。

| `no_candidate_reason` | 意味 | フロントの表示（[frontend#152](https://github.com/KDIX-SDL-EventSupportAppTeam/event-support-frontend/issues/152)） |
|---|---|---|
| `"ALL_VISITED"` | そのユーザーに未訪問の有効ブースが0件。全制覇した正常な終点 | 「すべてのブースを訪問しました」。**達成済み（訪問済み扱い）として描く** |
| `"INSUFFICIENT_BOOTHS"` | 未訪問の有効ブースは残っているが、全部すでにこのカードに載っている（有効ブース数 < 16）。運営側の設定都合 | 運営向けの異常。「ブースが足りません」相当 |
| `null` | 終端状態ではない通常のマス | — |

- **`source = "NO_CANDIDATE"` のときだけ `no_candidate_reason` が非 `null` になる。** 逆も成立する
- 値は**割当時点で凍結**する。あとから運営がブースを追加しても書き換わらない
- `is_achieved: true` なので `progress.achieved_cells` と `lines_completed` に**算入される**

### 必ず守ること

- `cells` は **position 昇順で必ず16件**
- `no_candidate_reason` は**全てのマスに必ず存在する**（該当しなければ `null`）
- **`is_revealed: false` のマスでは `booth` を必ず `null` にする。**
  解放前に中身を漏らさない。これは絶対の制約
- `coins` は返さない。ライン数だけを返す（[D-5](../01-concept/decisions.md)）
- `status` は返さない。カードの段階は保存していない（[D-8](../01-concept/decisions.md)）
- `reason` は返さない（[D-6](../01-concept/decisions.md)）。**ブース説明 `description` は返す**
- `unlock_events` は解放済みのペアを時刻順に。フロントは演出の再生済み判定に使う
- **`manual_code` は参加者向けのどのマス・どの一覧でも返さない**（issue #121）。
  手動チェックインの照合コードは掲示物からしか入手できないようにする。
  参加者に見せるブース番号は `display_code`（公開してよい小間番号。未設定イベントは `null`）

## POST /api/v1/events/:event_id/checkins

```json
// リクエスト
{ "method": "qr", "booth_id": "…", "checked_in_at": "2026-10-16T04:12:00.000Z" }
{ "method": "manual", "manual_code": "481502", "checked_in_at": "…" }
```

- `manual_code` は **6桁の数字（`^[0-9]{6}$`）**（issue #121）。桁数違い・英字混じりは 422 `VALIDATION_ERROR`。
  一致するブースが無ければ 404 `NOT_FOUND`。コードはサーバーが暗号論的乱数で採番し、運営が掲示物で配る

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
  "no_candidate_cells": [],
  "new_lines": 0,
  "lines_completed": 0
}
```

| フィールド | 説明 |
|---|---|
| `filled_cell` | 今回のチェックインで埋まったマス。カード外訪問なら `null` |
| `unlocked_positions` | **今回の解放で開放された外周 position の配列。** 解放が起きなければ空配列 |
| `unlocked_pairs` | 同じ解放の**ペア単位の内訳**（`pair_key` と、そのペアで開放された position）。解放が起きなければ空配列 |
| `no_candidate_cells` | 今回の解放で**終端状態になったマス**の一覧（issue #150）。`[{ "position": 4, "reason": "ALL_VISITED" }, …]`。該当が無ければ空配列。`unlocked_positions` の部分集合であり、`reason` の値は `GET /bingo/card` の `no_candidate_reason` と同じ |
| `new_lines` | 今回のチェックインで新たに成立したライン数 |
| `lines_completed` | 成立ライン数の合計 |

`pending_rating` は廃止した（server#133）。レスポンスにこのキーは**存在しない**。
評価はチェックイン直後にその場で行う（[rating-collection.md](../04-rating/rating-collection.md)）。

- `unlocked` という真偽値は**返さない。** 解放が複数回あるため、開放されたマスの配列を返す
- `coins_earned` は返さない（[D-5](../01-concept/decisions.md)）
- `no_candidate_cells` のマスは `is_achieved = 1` で確定するため、同じレスポンスの
  `new_lines` / `lines_completed` に**算入済み**である。全制覇時は6マスが同時に終端状態になり、
  ライン数が一気に跳ねうる（コインが上限まで出ることは許容する。issue #150）。
  **フロントはライン計算を自前でやり直さない**
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

## GET /api/v1/events/:event_id/checkins

自分のチェックイン履歴。各要素の `rated`（真偽値）で、あとから評価できるブースを判別する
（server#133 D1）。点数そのものは返さない。

```json
{
  "checkins": [
    {
      "id": "…",
      "booth_id": "…",
      "booth_name": "…",
      "method": "qr",
      "checked_in_at": "…Z",
      "synced_at": "…Z",
      "rated": false
    }
  ]
}
```

## POST /api/v1/events/:event_id/checkins/:checkin_id/rating

```json
{ "rating": 3, "comment": "任意", "context": "IMMEDIATE" }
→ { "rating_id": "…" }
```

- `rating` は `1 <= rating <= RATING_SCALE`（既定 4）。範囲外は 422
- `context` は `IMMEDIATE`（チェックイン直後）/ `MANUAL`（あとから）。省略時は `MANUAL`。
  `NEXT_CHECKIN` は新規には受け付けず 422（旧方式。既存データのため ENUM には残す）
- コメントは空文字・空白のみなら `NULL` に正規化する
- 同じ `checkin_id` への2回目は 409。他人の `checkin_id` は 404

## GET /api/v1/events/:event_id/gacha/coins

**器だけ用意する。ガチャ本体は後から実装する**（[D-5](../01-concept/decisions.md)）。

```json
{ "lines_completed": 2, "earned": 2, "used": 0, "available": 2, "max": 4 }
```

ビンゴ側から `lines_completed` を読み、ガチャ側が枚数へ換算する。
**ビンゴのモジュールはこのエンドポイントを知らない。**

## POST /api/v1/events/:event_id/gacha/coins/use

**器だけ用意する。** `gacha_coin_uses` に1行 INSERT し、残枚数を返す。

## GET /api/v1/booths/by-qr-token/:qr_token

掲示 QR（`https://<frontend>/c/<qr_token>`）の解決（issue #155）。フロントの `/c/:token` が
チェックイン確認画面にブース名を出すために使う。

- 認証: `Bearer`（参加者 JWT）。URL に `event_id` が無いので `requireEventMatchesJwt` は使えず、
  **解決したブースの `event_id` が JWT の `event_id` と一致しなければ 404**（403 にしない。他イベントのトークンの存在を漏らさない）
- 200: `{ data: { booth: { id, name, event_id } } }`
- 404 `NOT_FOUND`: 「QRコードに一致するブースがありません」。**存在しない・形式不正・他イベント・`is_active = 0` はすべて同じ 404**
- **`qr_token` をレスポンスに含めない**
- チェックイン自体は解決後の `booth_id` で既存の `method: 'qr'` を通す（`method: 'qr_token'` は作らない）

## 削除するエンドポイント

- `GET /api/v1/events/:event_id/recommendations`
- `POST /api/v1/events/:event_id/recommendations/:recommendation_id/select`

旧「推薦欄」方式のもの。**推薦を外部 UI に切り出さない**という制約に反する
（[D-11](../01-concept/decisions.md)）。フロントの `CheckInRecommendView` も削除する。

## socket.io

| room | イベント | payload |
|---|---|---|
| `event:{event_id}:user:{user_id}` | `bingo:unlocked` | `{ unlock_event_ids: [...], released_positions: [1,13,3,12], unlocked_pairs: [{ pair_key: "5-9", released_positions: [1,13] }], no_candidate_cells: [{ position: 1, reason: "ALL_VISITED" }], unlocked_at: "…Z" }` |
| `event:{event_id}:admin` | `checkin:new` | `{ booth_id, booth_name, user_display_name, checked_in_at }` |
| `event:{event_id}:admin` | `rating:new` | `{ booth_id, booth_name, rating, comment, user_display_name }` |

**`bingo:unlocked` は副経路である。** 正の経路はチェックインレスポンスの `unlocked_positions`。
スマホをポケットに入れる・別アプリを開くなどで接続は簡単に切れるため、
socket に依存した設計にしない。
