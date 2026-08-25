# 運営向けエンドポイント

既存 `/admin/*` の規約に従う（`manager` は編集可、`viewer` は読み取りのみ、操作は `audit_logs` に記録）。

## 1. ブースの有効・無効切り替え（E5）

```
PATCH /events/:event_id/admin/booths/:booth_id/active
Body: { "is_active": false }
```

- `manager` のみ。`audit_logs` に記録する
- **無効化しても、既に割り当て済みのマスは自動では変わらない。**以降の割当候補から外れるだけ

## 2. 割当済みマスのブース差し替え（E5）

当日中止になったブースが既に誰かのマスに入っている場合の救済。

```
POST /events/:event_id/admin/bingo/reassign
Body: { "from_booth_id": "…", "to_booth_id": "…" }
```

- 該当イベントの `bingo_cells` のうち `booth_id = from_booth_id` かつ **`state <> 'ACHIEVED'`** の行を対象に差し替える
- 差し替え先が既にそのカードに載っている場合はそのカードをスキップする（`UNIQUE (card_id, booth_id)` 違反を避ける）
- `to_booth_id` は**同一イベントかつ `is_active = 1` のブースに限る**（不一致は 404）。`from_booth_id` と同一なら 422
- 差し替えた件数を返す。`cell_assignment_logs` に `strategy='ADMIN_REASSIGN'` で記録するのは、**実際に差し替わったマスのみ**（競合で `ACHIEVED` になったマスにはログを残さない）
- `manager` のみ。`audit_logs` に記録する

> `to_booth_id` を省略した場合は[フォールバック規則](../05-recommender/fallback.md)でカードごとに個別選定する、という拡張が考えられるが**今回は実装しない**。運営が1ブースを指定する形で十分。

## 3. ダッシュボードの指標追加

運営ダッシュボードに以下を出す。**当日の運用判断と、評価回収率の監視のため**（[04-rating](../04-rating/rating-collection.md)）。

| 指標 | 算出 |
|---|---|
| カード発行数 | `bingo_cards` の件数 |
| 解放到達率 | `status='UNLOCKED'` / 全カード |
| 平均解放所要時間 | `unlocked_at - created_at` の中央値 |
| 評価回収率 | `booth_ratings` 件数 / `check_ins` 件数 |
| カード外訪問率 | `cell_id IS NULL` / 解放後のチェックイン件数 |

いずれも **`users.role = 'participant'` に限定**して集計する（E11）。
