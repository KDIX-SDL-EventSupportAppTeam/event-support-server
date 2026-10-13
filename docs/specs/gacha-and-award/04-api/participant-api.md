---
状態: 確定
最終更新: 2026-10-13
---

# 参加者 API

認証は既存の `requireBearerAuth` + `requireEventMatchesJwt`。応答は `sendOk` / `sendFail`。

## GET /api/v1/events/:event_id/gacha/coins

```json
{
  "is_enabled": true,
  "lines_completed": 3,
  "earned": 3,
  "used": 1,
  "available": 2,
  "max_coins": 4
}
```

- **副作用なし。カードが無ければ作らずに `lines_completed: 0` を返す**
  （コイン枚数の問い合わせがビンゴカードを発行するのは責務として誤り。
  ホーム初回表示で `GET /bingo/card` と同時に走り、`ensureCard` が競合していた）
- `is_enabled = false` でも `200` を返す。枚数は算出して返し、UI 側で「準備中」を出す

## GET /api/v1/events/:event_id/gacha/coins/history

本人のコイン使用履歴。コインの数え方が食い違ったという申し出に、運営がその場で
本人の状況を確認するために使う（フロントの 0 枚時の履歴画面が呼ぶ）。

```json
{
  "email": "user@example.com",
  "display_name": "...",
  "is_enabled": true, "lines_completed": 3, "earned": 3,
  "used": 2, "available": 1, "max_coins": 4,
  "uses": [
    { "coin_index": 0, "used_at": "2026-10-16T05:12:03.000Z" },
    { "coin_index": 1, "used_at": "2026-10-16T05:12:04.000Z" }
  ]
}
```

- 集計値（`lines_completed` 〜 `max_coins`）は `GET /gacha/coins` と同じ関数で算出する。値は常に一致する
- `uses` は `coin_index` 昇順。**JWT の `sub`（本人）の行だけ**。未使用なら `[]`
- `used_at` は UTC の ISO 8601（末尾 `Z`）。`gacha_coin_uses.used_at` はアプリが UTC で明示的に書く
  （DB 既定値に任せるとさくらでは JST が入り、`Z` を付けて返すと 9 時間ずれるため）
- 副作用なし。`is_enabled = false` でも `200` を返す

## POST /api/v1/events/:event_id/gacha/coins/use

リクエスト:

```json
{ "idempotency_key": "0f4f2b3e-..." }
```

応答（`200`）: GET と同じ形に消費結果を足したもの。

```json
{
  "is_enabled": true, "lines_completed": 3, "earned": 3,
  "used": 2, "available": 1, "max_coins": 4,
  "coin_index": 1, "used_at": "2026-10-16T04:12:33.000Z"
}
```

エラー:

| コード | HTTP | 条件 |
|---|---|---|
| `INVALID_BODY` | 400 | `idempotency_key` が無い、または UUID 形式でない |
| `GACHA_DISABLED` | 403 | `is_enabled = 0` |
| `NO_COINS_AVAILABLE` | 409 | 所持枚数 0 |

**同じ `idempotency_key` の再送は `200` を返し、`used` は増えない。**
既に消費済みの操作に対しては、その行の `coin_index` / `used_at` をそのまま返す。
