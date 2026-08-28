---
状態: 確定
最終更新: 2026-08-27
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

- 副作用なし。ただし `ensureCard` でカードが無ければ発行される（既存挙動を踏襲）
- `is_enabled = false` でも `200` を返す。枚数は算出して返し、UI 側で「準備中」を出す

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
