# 解放処理（本機能の中核）

**トリガー:** 中央4マスが全て `ACHIEVED` になった瞬間（= 実訪問3件目の完了時）。チェックイン処理の同一リクエスト内で同期的に実行する。

## 手順

1. **権利の取得（冪等性の要）**

```sql
UPDATE bingo_cards SET status='UNLOCKED', unlocked_at=?, updated_at=?
WHERE id=? AND status='CENTER_ONLY'
```

- `affectedRows = 1` → このリクエストが解放処理を行う
- `affectedRows = 0` → **既に他のリクエストが解放済み。何もせずカードの現状を返す**（`unlocked: false` を返す。演出の二重発火を防ぐ）

**`SELECT ... FOR UPDATE` は使えない。**本番の DB アクセスは HTTP プロキシ経由で 1リクエスト＝1 SQL であり、トランザクションも行ロックも存在しない（[D-7](../01-concept/decisions.md)）。条件付き UPDATE の `affectedRows` が唯一の排他手段である。

2. **推薦サービス呼び出し** — [05-recommender/contract.md](../05-recommender/contract.md)
3. **外側12マスへの書き込み**

```sql
UPDATE bingo_cells
SET booth_id=?, state='EMPTY', source='RECOMMEND', assigned_at=?
WHERE id=? AND state='LOCKED'
```

`position` 昇順の12マスに、推薦結果を返された順で割り当てる。**推薦側が返す順序に意味を持たせない**こと（配置位置のランダム化は将来の実験デザインで扱う。[Q-5](../09-open-questions/open-questions.md)）。

4. **`cell_assignment_logs` に12行記録** — `global_checkin_count` を必ず入れる（[07](../07-research-logging/logging.md)）
5. **socket.io で解放を push**

```
room:  event:{event_id}:user:{user_id}
event: bingo:unlocked
data:  { card_id, unlocked_at }
```

> 現在の `src/plugins/socket.ts` は `event:{event_id}` と `event:{event_id}:admin` にしか join していない。**ユーザー個別 room への join を追加すること**（`socket.join('event:'+user.event_id+':user:'+user.sub)`）。

6. レスポンスの `unlocked: true` を返す（**フロントはこれを見て演出を出す。socket は取りこぼし対策の副経路**）

## 除外条件（必須）

推薦に渡す `exclude_booth_ids` には必ず以下を含める。

- 既にカードに載っているブース4件（中央4マス）
- `is_active = 0` のブース（当日中止。E5）
- そのユーザーが既にチェックイン済みのブース全て（ボーナスブースへ訪問した場合など、中央4件と一致しないことがある）

**外側12マスに重複ブースが入らないこと。**`bingo_cells` の `UNIQUE (card_id, booth_id)` が最終防衛線だが、推薦結果の時点で重複を除去し、不足分をフォールバックで補うこと。

## 候補が12件に満たない場合

小規模イベントでは `有効ブース数 - 既訪問数 < 12` がありうる。この場合:

- 埋められるだけ埋め、残りのマスは **`state='EMPTY'`, `booth_id=NULL`** にする（`LOCKED` のまま放置しない）
- そのマスは達成不能になるが、カードは解放済みとして扱う
- 40ブース規模の本番では発生しない。テスト環境向けの安全弁

## 性能要件

**2秒以内に完了させる。**参加者を待たせない。13:30–15:30 は同時滞在89名・1分あたり9.3件のチェックインが発生し、**解放もこの時間帯に集中する**（[background.md](../01-concept/background.md) 5）。

- 推薦サービスへの HTTP は **`RECOMMENDER_TIMEOUT_MS`（既定 1500）でアボート**し、超えたら即フォールバックへ
- 外側12マスの UPDATE と `cell_assignment_logs` の INSERT は**まとめて発行する**。プロキシは 1リクエスト＝1 SQL なので、12回×2の往復は許容できない。`INSERT ... VALUES (...),(...)` の複数行 INSERT と、`CASE WHEN` を使ったまとめ UPDATE を使う
- Cloud Run は `max-scale=1`（WebSocket 維持のため。[ADR 0002](../../adrs/0002-cloud-run-single-instance-for-websocket.md)）。**インスタンスを増やして捌く選択肢は無い**。この制約下で 2 秒を守ること

## 失敗時フォールバック（必須）

**推薦サービスがタイムアウト・エラーを返しても、解放は必ず成功させる。参加者を `LOCKED` のまま放置しない。**
割当規則は [05-recommender/fallback.md](../05-recommender/fallback.md)。

さらに、フォールバックすら失敗した場合（DB エラー等）でも:

- **カードの `status` は既に `UNLOCKED` になっている**（手順1で先に更新済み）。この状態でマスが `LOCKED` のまま残るのが最悪のケース
- 対策: `GET /bingo/card` 側で「`status='UNLOCKED'` なのに `state='LOCKED'` のマスがある」ことを検知したら、**その場でフォールバック割当を実行して修復する**（self-healing）。カード取得は参加者が必ず叩くため、次のポーリングで回復する

## テストで固定すること

- 3件目のチェックインで `unlocked: true` が返り、外側12マスに `booth_id` が入ること
- 同じカードに対して解放処理を並行に2回走らせても、`cell_assignment_logs` が **12行だけ**であること
- 推薦サービスを 500 / タイムアウトにしても解放が成功し、`strategy='FALLBACK_COVERAGE'` で12マス埋まること
- 中央4マス完成時点で**コインが付与されないこと**（[lines-and-coins.md](lines-and-coins.md)）
