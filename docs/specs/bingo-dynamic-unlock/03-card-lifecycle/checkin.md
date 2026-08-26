---
状態: 実装済み
最終更新: 2026-08-25
---

# チェックインとマスの割当

チェックイン API の中で、カードのどのマスが埋まるかを決める。

## 全体の流れ

```
1. チェックインを記録する（check_ins に INSERT）
2. カードを取得する（無ければ作る。ensureCard）
3. マスの割当を決める（下記の分岐）
4. 中央マスが埋まったなら、解放判定を行う（unlock.md）
5. ライン数を数える
6. 未評価の直前チェックインを探す（rating-collection.md）
7. レスポンスを返す
```

## マスの割当（分岐）

チェックインしたブースを `B` とする。

### 分岐1: そのブースが、既に見えているマスに載っている

```sql
SELECT id, position, zone FROM bingo_cells
WHERE card_id = ? AND booth_id = ? AND is_revealed = 1 AND is_achieved = 0
LIMIT 1
```

該当すればそのマスを達成にする。**事前推薦マス（position 5）と、解放済みの外周マスがこれに当たる。**

```sql
UPDATE bingo_cells SET is_achieved = 1, achieved_at = ?
WHERE id = ? AND is_achieved = 0
```

`affectedRows = 1` を取れたときだけ `check_ins.cell_id` を更新する。

- **中央マス（position 5）だった場合は、続けて解放判定を行う**
- 外周マスだった場合は解放判定を行わない（[unlock-pairs.md](unlock-pairs.md)）

### 分岐2: 中央マスに空きがある

中央マスのうち `booth_id IS NULL` のものが残っていれば、そこへ `B` を割り当てる
（**後出し割当**）。position の小さい順に1つ選ぶ。

```sql
UPDATE bingo_cells
SET booth_id = ?, is_revealed = 1, is_achieved = 1,
    source = 'FREE_VISIT', assigned_at = ?, achieved_at = ?
WHERE id = ? AND booth_id IS NULL
```

`affectedRows = 1` を取れたリクエストだけが割当の権利を持つ（[D-15](../01-concept/decisions.md)）。
0 なら他のリクエストが先に埋めたので、分岐1からやり直す。

**続けて解放判定を行う。**

### 分岐3: どちらでもない（カード外訪問）

`check_ins.cell_id` は `NULL` のまま。ビンゴには寄与しない（[D-16](../01-concept/decisions.md)）。

**記録は必ず残す。** 推薦なしでの自発訪問は、セレンディピティ分析の対照群になる
（[07-research-logging/serendipity-data.md](../07-research-logging/serendipity-data.md)）。

**評価は同じように求める**（[D-17](../01-concept/decisions.md)）。分岐にカード内外の条件を入れない。

## 分岐の順序が重要

**必ず分岐1を先に評価する。** 順序を逆にすると、事前推薦マスのブースへ訪問した参加者が、
そのブースを中央の空きマスに二重に割り当ててしまう
（`UNIQUE (card_id, booth_id)` で最終的には防がれるが、解放処理が失敗して 500 になる）。

## 同一ブースへの再訪問

`check_ins` の `UNIQUE (user_id, booth_id)` により構造的に起きない。
プロキシは重複キーを 500 に潰すため、**INSERT 前に SELECT で確認**し、
既にあれば 409 `CONFLICT` を返す（既存実装どおり）。

## クールタイム

`CHECKIN_COOLDOWN_SEC` の既定は `0`（無効）。0 のときは判定処理自体をスキップする
（[D-18](../01-concept/decisions.md)）。

## レスポンス

[06-api/participant-api.md](../06-api/participant-api.md) を参照。
`filled_cell` / `unlocked_positions` / `unlocked_pairs` / `new_lines` / `pending_rating` を含む。

## テストで固定すること

- 中央マスが空のとき、訪問したブースが中央マスに `FREE_VISIT` で入る
- 事前推薦マスのブースへ訪問すると、**そのマスが達成になる**（新しい中央マスを消費しない）
- 解放済みの外周マスのブースへ訪問すると、そのマスが達成になり**解放は起きない**
- どこにも載らないブースへ訪問すると `cell_id = NULL` で記録され、それでも評価を求められる
- 同じブースへの2回目のチェックインは 409 になる
