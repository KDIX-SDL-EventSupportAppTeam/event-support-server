# 参加者向けエンドポイント

**既存の API 規約に従う。** `sendOk` / `sendFail`、zod バリデーション、`requireBearerAuth` + `requireEventMatchesJwt` の preHandler、**JSON は snake_case**、パスは `/api/v1/events/:event_id/...`。企画書に書かれていた `/api/bingo/card` のような形は既存構成と合わないので採用しない。

---

## 1. `GET /events/:event_id/bingo/card` （新規）

自分のカード状態を返す。カードが無ければ**この呼び出しで生成する**（[signup.md](../03-card-lifecycle/signup.md)）。

```json
{
  "card_id": "…",
  "status": "CENTER_ONLY",
  "unlocked_at": null,
  "rating_scale": 3,
  "progress": { "center_filled": 2, "center_total": 4, "visits_to_unlock": 1 },
  "coins": { "earned": 0, "max": 4 },
  "cells": [
    { "position": 0, "zone": "OUTER", "state": "LOCKED", "source": null, "booth": null },
    { "position": 5, "zone": "CENTER", "state": "ACHIEVED", "source": "SIGNUP_BONUS",
      "booth": { "id": "…", "name": "…", "manual_code": "S040" },
      "reason": null },
    { "position": 1, "zone": "OUTER", "state": "EMPTY", "source": "RECOMMEND",
      "booth": { "id": "…", "name": "…", "manual_code": "S013" },
      "reason": { "summary": "…", "detail": "…" } }
  ]
}
```

- **`state='LOCKED'` のマスでは `booth` を必ず `null` にする。**フロントに漏らすと解放前に中身が見えてしまう。`reason` も同様
- `visits_to_unlock` = `3 - (中央マスのうち source='FREE_VISIT' かつ ACHIEVED の数)`。解放後は `0`
- `coins.earned` は `bingo_cells` から再計算した値（[lines-and-coins.md](../03-card-lifecycle/lines-and-coins.md)）
- `reason` の中身の生成ロジックは未決定（[Q-3](../09-open-questions/open-questions.md)）。**`cell_assignment_logs.reason_payload` をそのまま返すだけの通し口を用意し、当面 `null` を返してよい**
- `cells` は `position` 昇順で16件返す

---

## 2. `POST /events/:event_id/checkins` （既存を拡張）

**リクエストは変更しない。** 既存の discriminated union（`qr` / `manual`）をそのまま使う。

レスポンスに以下を追加する（既存の `checkin_id` / `booth` / `synced_at` は維持）。

```json
{
  "result": "OK",
  "checkin_id": "…",
  "booth": { "id": "…", "name": "…" },
  "synced_at": "2026-10-16T04:12:00Z",
  "cooldown_remaining_sec": 0,
  "filled_cell": { "position": 5 },
  "pending_rating": { "checkin_id": "…", "booth_id": "…", "booth_name": "…" },
  "unlocked": false,
  "new_lines": 0,
  "coins_earned": 0
}
```

| フィールド | 意味 |
|---|---|
| `result` | `OK` / `ALREADY_VISITED` / `COOLDOWN` |
| `filled_cell` | 埋まったマス。カード外訪問なら `null` |
| `pending_rating` | 未評価の直近チェックイン。無ければ `null`（[04-rating](../04-rating/rating-collection.md)） |
| `unlocked` | この呼び出しで解放が起きたら `true`。**フロントはこれを見て演出を出す** |
| `new_lines` | この呼び出しで新規成立したライン数 |
| `coins_earned` | 累計獲得コイン（最大4でクリップ済み） |

**ステータスコード:** `OK` は 200、`ALREADY_VISITED` は 409（`sendFail` ではなく `sendOk` で `result` を返してもよいが、**既存実装は 409 + `CONFLICT` なのでそれを維持し、フロント側で正常系として扱う**）、`COOLDOWN` は 429。

---

## 3. `POST /events/:event_id/checkins/:checkin_id/rating` （既存を拡張）

```json
{ "rating": 3, "context": "NEXT_CHECKIN" }
```

- `context` は `NEXT_CHECKIN` / `MANUAL` / `EXIT`。**省略時 `MANUAL`**
- `rating` は `1..RATING_SCALE` を検証（zod は `z.number().int().min(1)` にし、上限は実行時に config から見る）
- 重複時 409（既存挙動を維持）

---

## 4. 事前アンケート

**新規エンドポイントを作らない。** 既存の `src/routes/v1/survey.ts` をそのまま使う（[D-8](../01-concept/decisions.md)）。設問構造の変更は [Q-2](../09-open-questions/open-questions.md) が決まってから。

---

## socket.io

| イベント | room | data | 備考 |
|---|---|---|---|
| `bingo:unlocked` | `event:{event_id}:user:{user_id}` | `{ card_id, unlocked_at }` | **新規。** `src/plugins/socket.ts` にユーザー個別 room への join を追加すること |
| `checkin:new` | `event:{event_id}:admin` | 既存のまま | 変更しない |
| `rating:new` | `event:{event_id}:admin` | 既存のまま | 変更しない |

`bingo:unlocked` は取りこぼし対策の副経路である。**正の経路はチェックインレスポンスの `unlocked: true`。**
