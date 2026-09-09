---
状態: 確定
最終更新: 2026-08-27
---

# 運営・管理 API

## GET / PUT /api/v1/organizer/events/:event_id/gacha/settings

`organizer` 権限。PUT の body は 4項目すべて必須。

```json
{ "is_enabled": true, "coins_per_line": 1, "max_coins": 4, "bonus_coins": 0 }
```

バリデーション:

| 項目 | 制約 |
|---|---|
| `coins_per_line` | 0 以上 10 以下の整数 |
| `max_coins` | 0 以上 50 以下の整数 |
| `bonus_coins` | 0 以上 10 以下の整数 |

- 行が無ければ INSERT、あれば UPDATE（`INSERT ... ON DUPLICATE KEY UPDATE` の単一 SQL）
- 変更は `audit.ts` に記録する（誰がいつ何を何に変えたか）
- **`max_coins` を下げても、既に使用済みのコインは戻らない。** `used > earned` になった
  ユーザーは `available = 0` になるだけで、エラーにはしない

## GET /api/v1/admin/events/:event_id/gacha/stats

当日モニタ用。

```json
{
  "is_enabled": true,
  "total_used": 128,
  "total_earned": 240,
  "users_with_coins": 64,
  "users_who_used": 51,
  "used_by_hour": [{ "hour": "2026-10-16T04:00:00.000Z", "count": 31 }]
}
```

`idx_gacha_event_used_at` で引く。**参加者 API のレスポンスタイムに影響しないこと**（別クエリ）。

- `is_enabled` … 現在ガチャが有効か（frontend #87 T-3「止まっていることが画面で分かる」用。issue #122）
- `total_earned` … 換算後の獲得コイン総数。`available = total_earned - total_used`。
  `role='participant'` のカードだけを数える（スタッフ・出展者は除外）

## PATCH /api/v1/admin/events/:event_id/gacha/enabled（issue #122）

当日会場で運営ダッシュボードを見ている **`manager`** が、ガチャを止める／再開する。

- 認可: `requireManager` ＋ `requireEventMatchesJwt`（**`viewer` は 403**。参加者も 403）
- ボディ: `{ "is_enabled": boolean }`
- **`is_enabled` だけを変える。** `coins_per_line` / `max_coins` / `bonus_coins` は触らない
  （organizer の4項目まとめ PUT は当日の緊急停止に向かないため、別に用意する）
- `gacha_settings` に行が無いイベントは `DEFAULT_GACHA_SETTINGS` を土台に upsert する
- 監査ログ `gacha.enabled.update`（`{ before, after }`）を残す
- 参加者の**獲得済みコインは消えない**（`is_enabled = false` は「使えない」であって「持っていない」ではない）
- レスポンス: `{ "is_enabled": boolean }`
