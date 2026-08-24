# チェックイン処理

既存の `POST /events/:event_id/checkins`（`src/routes/v1/checkins.ts`）を拡張する。**リクエスト形式は変えない**（`{method:'qr', booth_id, checked_in_at}` / `{method:'manual', manual_code, checked_in_at}`）。レスポンスにフィールドを追加する（[06-api](../06-api/participant-api.md)）。

## 共通の前段（解放前後で同じ）

1. ブース解決（既存ロジック。QR は `booth_id`、手動は `manual_code`）。**`is_active = 0` のブースは 404 相当で拒否する**
2. `ensureCard()`（[signup.md](signup.md)）でカードを取得。無ければここで作る
3. **重複チェック** — `SELECT id FROM check_ins WHERE user_id=? AND booth_id=?`。既にあれば HTTP 409 + `result: 'ALREADY_VISITED'` を返してここで終了する。既存実装の 409 を維持するが、**フロントはこれをエラーではなく正常なお知らせとして扱う**（E1）
4. **クールタイム判定** — [cooldown.md](cooldown.md)。**既定 `CHECKIN_COOLDOWN_SEC=0` では判定自体をスキップする。** 有効時に抵触したら 429、残り秒数を返す
5. `visit_order` の採番 — `SELECT COALESCE(MAX(visit_order),0)+1 FROM check_ins WHERE user_id=? AND event_id=?`
6. `check_ins` へ INSERT（`cell_id` は後述の割当後に UPDATE、または割当を先に決めてから INSERT する）
7. **未評価の直近チェックインを `pending_rating` として算出する**（[04-rating](../04-rating/rating-collection.md)）。今作成したチェックイン自身は除く

## 解放前（`status='CENTER_ONLY'`）— 後出し割当

中央マスのうち `state='EMPTY'` のものを **`position` 昇順で1つ**選び、今チェックインしたブースを割り当てる。

```sql
UPDATE bingo_cells
SET booth_id=?, state='ACHIEVED', source='FREE_VISIT', assigned_at=?, achieved_at=?
WHERE id=? AND state='EMPTY'
```

- **`affectedRows = 1` を確認する。** 0 なら他のリクエストが先に埋めたので、`EMPTY` のマスを取り直して再試行する（最大3回）。トランザクションが使えないため、これが直列化の手段である（[D-7](../01-concept/decisions.md)）
- 割り当てたマスの `id` を `check_ins.cell_id` に書く
- `EMPTY` の中央マスが1つも無い場合（＝実質すでに中央完成）は、解放処理へ進む

**★ これが「後出し」の実体。参加者が自分で選んだブースを事後的にマスに入れる。**この仕組みにより、解放前は参加者の全訪問がカードに反映される。

割当後、中央4マスが**全て `ACHIEVED`** になったら [unlock.md](unlock.md) の解放処理を呼ぶ。

## 解放後（`status='UNLOCKED'`）

1. そのブースが**外側マスに存在するか**を引く（`SELECT id FROM bingo_cells WHERE card_id=? AND booth_id=?`）
2. 存在すれば `UPDATE ... SET state='ACHIEVED', achieved_at=? WHERE id=? AND state='EMPTY'` し、`check_ins.cell_id` に紐づける
3. 存在しなければ **`cell_id = NULL` のまま記録する**（カード外訪問。[D-4](../01-concept/decisions.md)）
   - ビンゴには寄与しないが、**評価入力は同じように求める**（[D-12](../01-concept/decisions.md)）
4. [lines-and-coins.md](lines-and-coins.md) のライン成立判定を行う

## socket.io

既存の管理画面向け通知 `checkin:new`（room: `event:{eventId}:admin`）は**そのまま維持する**。本機能で追加するのは解放通知のみ（[unlock.md](unlock.md)）。

## ファイル配置

ルート本体は肥大化させない。

| ファイル | 責務 |
|---|---|
| `src/routes/v1/checkins.ts` | HTTP の入出力・バリデーション・レスポンス組み立てのみ |
| `src/lib/bingo/ensureCard.ts` | カード get-or-create と参加ボーナス |
| `src/lib/bingo/assignCenterCell.ts` | 後出し割当（条件付き UPDATE と再試行） |
| `src/lib/bingo/unlock.ts` | 解放処理（冪等性・推薦呼び出し・フォールバック） |
| `src/lib/bingo/lines.ts` | ライン判定とコイン計算（**純関数。DB を触らない**） |
| `src/lib/bingo/cooldown.ts` | クールタイム判定 |
