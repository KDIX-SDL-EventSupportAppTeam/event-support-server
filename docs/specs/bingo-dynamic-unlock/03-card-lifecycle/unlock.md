---
状態: 実装済み
最終更新: 2026-08-25
---

# 解放処理（本機能の中核）

**トリガー:** 中央マスが新たに達成された瞬間。チェックイン処理の同一リクエスト内で同期的に実行する。
外周マスの達成では実行しない（[unlock-pairs.md](unlock-pairs.md)）。

## 手順

### 1. 新たに成立したペアを求める（純関数）

```
達成済みの中央 position の集合  ->  成立しているペアの一覧
すでに解放済みのペア（card_unlock_events から）を引く  ->  新規ペア
```

新規ペアは 1組（中央2つ目）か 2組（3つ目）か 3組（4つ目）。
**この計算に DB も通信も出てこない。純関数として切り出す。**

### 2. ペアごとに解放の権利を取る（冪等性の要）

新規ペア1組につき、`card_unlock_events` に1行 INSERT する。

- **INSERT 前に `SELECT ... WHERE card_id=? AND pair_key=?` で存在確認する**
  （プロキシは重複キーを 500 に潰す。[ADR 0001](../../../decisions/adrs/0001-sakura-proxy-error-masking.md)）
- 既に行があれば、**そのペアは他のリクエストが処理済み。何もせず次のペアへ進む**
- INSERT できたリクエストだけが、そのペアの推薦と割当を行う

`UNIQUE (card_id, pair_key)` が最終防衛線である。

> **`SELECT ... FOR UPDATE` は使えない。** 本番の DB アクセスは HTTP プロキシ経由で
> 1リクエスト = 1SQL であり、トランザクションも行ロックも存在しない（[D-15](../01-concept/decisions.md)）。

### 3. 推薦サービスを呼ぶ

新規ペアが複数ある場合は、**1回のリクエストにまとめる**（要求件数 = 新規ペア数 × 2）。
契約は [05-recommender/contract.md](../05-recommender/contract.md)。

`RECOMMENDER_URL` 未設定・タイムアウト・エラーなら
[フォールバック](../05-recommender/fallback.md)へ落ちる。**解放そのものは必ず成功させる。**

### 4. 外周マスへ書き込む

各ペアの `released_positions` に、推薦結果を順に割り当てる。

```sql
UPDATE bingo_cells
SET booth_id = ?, is_revealed = 1, source = 'RECOMMEND', assigned_at = ?
WHERE id = ? AND is_revealed = 0
```

**推薦側が返す順序に意味を持たせない。** 2マスのどちらにどのブースを置くかは任意でよい。

複数マスの UPDATE は `CASE WHEN` でまとめて1回の SQL にする（往復回数を減らす）。

### 5. 推薦度を記録する

`recommendation_scores` に、除外されていない**全候補ブース**を1行ずつ INSERT する
（[D-10](../01-concept/decisions.md)）。複数行 INSERT でまとめて1回にする。

- `was_assigned` はマスに載ったものだけ 1
- `interest_match` と `attributes` は**推薦時点の値を凍結**して保存する
- 詳細は [07-research-logging/logging.md](../07-research-logging/logging.md)

### 6. socket.io で通知する

```
room:  event:{event_id}:user:{user_id}
event: bingo:unlocked
data:  { unlock_event_ids: [...], released_positions: [4, 7], unlocked_at: "...Z" }
```

**正の経路はチェックインレスポンスの `unlocked_positions`。socket は取りこぼし対策の副経路。**

### 7. レスポンスに含める

`unlocked_positions`（今回開放された外周 position の配列）を返す。
フロントはこれを見て演出を出す。空配列なら演出しない。

## 除外条件（必須）

推薦に渡す `exclude_booth_ids` には必ず以下を含める。

- 既にカードに載っているブース全て（中央・外周・事前推薦マスを問わず）
- `is_active = 0` のブース（当日中止）
- そのユーザーが既にチェックイン済みのブース全て（カード外訪問を含む）
- **前回までの解放で既に外周マスに載せたブース**（2回目・3回目の解放で重要）

**外周マスに重複ブースが入らないこと。** `bingo_cells` の `UNIQUE (card_id, booth_id)` が
最終防衛線だが、推薦結果の時点で重複を除去し、不足分をフォールバックで補うこと。

## 候補が足りない場合

小規模イベントでは `有効ブース数 - 既訪問数 < 必要数` がありうる。

- 埋められるだけ埋め、残りは **`is_revealed = 1`, `booth_id = NULL`** にする
- そのマスは達成不能になるが、解放済みとして扱う（`is_revealed = 0` のまま放置しない）
- 40ブース規模の本番では発生しない。テスト環境向けの安全弁

## 性能要件

**2秒以内に完了させる。** 参加者を待たせない。
13:30–15:30 は同時滞在89名・1分あたり9.3件のチェックインが発生し、
**解放もこの時間帯に集中する**（[background.md](../01-concept/background.md) 5）。

- 推薦サービスへの HTTP は `RECOMMENDER_TIMEOUT_MS`（既定 **1000**）でアボートし、
  超えたら即フォールバックへ。解放が3回に増えたため、旧仕様の 1500 から詰める
- 外周マスの UPDATE と `recommendation_scores` の INSERT は**まとめて発行する**。
  プロキシは1リクエスト＝1SQL なので、往復回数がそのまま所要時間になる
- Cloud Run は `max-instances=1`（[ADR 0002](../../../decisions/adrs/0002-cloud-run-single-instance-for-websocket.md)）。
  **インスタンスを増やして捌く選択肢は無い**。この制約下で2秒を守る

## 失敗時フォールバック（必須）

**推薦サービスがタイムアウト・エラーを返しても、解放は必ず成功させる。
参加者を見えないマスのまま放置しない。** 割当規則は
[05-recommender/fallback.md](../05-recommender/fallback.md)。

さらに、フォールバックすら失敗した場合（DB エラー等）でも:

- `card_unlock_events` の行は既に作られている（手順2で先に INSERT 済み）。
  この状態でマスが `is_revealed = 0` のまま残るのが最悪のケース
- 対策: **カード取得 API 側で「解放イベントがあるのに、その `released_positions` の
  マスが `is_revealed = 0` である」ことを検知したら、その場でフォールバック割当を実行して修復する**
  （自己修復）。カード取得は参加者が必ず叩くため、次のポーリングで回復する
- **修復の対象は解放イベントごとに独立している。** 3回ぶんすべてを点検する

## テストで固定すること

- 中央2マス目の達成で、対応するペアの外周2マスだけが `is_revealed = 1` になる
- **対応しないマスは `is_revealed = 0` のままである**
- 中央3マス目の達成で、新たに2組が成立し4マスが開放される
- 中央4マス目の達成で、新たに3組が成立し6マスが開放される。累計で外周12マスすべて
- 中央の埋まり順を変えても、最終的に開放されるマスは常に12マスで過不足がない
- 外周マスの達成では解放が一切起きない
- 同じペアで解放処理を並行に2回走らせても、`card_unlock_events` は1行だけ
- 推薦サービスを 500 / タイムアウトにしても解放が成功し、フォールバックでマスが埋まる
- 解放イベントがあるのにマスが見えない状態を作ると、カード取得で自己修復される
