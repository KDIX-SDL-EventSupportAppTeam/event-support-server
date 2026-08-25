---
状態: 実装済み
最終更新: 2026-08-25
---

# 評価収集（P0 — 理論の成立条件）

**これは UX 改善ではない。** 評価の回収率が決定表の件数を決め、決定表の件数が
DRSA を使えるかどうかを決める（[background.md](../01-concept/background.md) 7）。
回収率が上がらなければ推薦手法そのものが成立しない。**最優先で実装する。**

## 設計

**独立した評価画面を作らない。チェックイン処理のモーダル内に組み込む。**

「後で評価してね」に依存すると回収率は3割を切る（去年のアワード投票確定率 36.4% が基礎値）。
次のブースで QR を読んだ瞬間に、**前のブースの評価を1タップで聞く**。
行動の流れに埋め込まれるため回収率が上がり、記憶も新しい。

## UI（[D-7](../01-concept/decisions.md)）

**星4段階（中央値なし）＋ コメント入力欄 ＋「完了」ボタン1つ。**

- 5段階は中間（3）に集中しやすく、実験データとして分析しづらい
- 「評価を送信」「コメント送信」の2ボタン構成は、どちらをスキップしたか区別がつかない
- ボタンを1つにすることで、「星だけ」「星＋コメント」「何もせず閉じる」の3状態が明確になる

詳細な画面仕様はフロント側 `event-support-frontend/docs/specs/bingo-dynamic-unlock/` を参照。

## サーバー側の責務

チェックイン API のレスポンスに `pending_rating` を含める。

```json
"pending_rating": { "checkin_id": "…", "booth_id": "…", "booth_name": "…" }
```

未回収がなければ `null`。

**算出規則:** そのユーザー・そのイベントの中で、`booth_ratings` がまだ無いチェックインのうち
`checked_in_at` が最新のもの。**今まさに作成したチェックイン自身は除く。**

```sql
SELECT ci.id, ci.booth_id, b.name
FROM check_ins ci
JOIN booths b ON b.id = ci.booth_id
LEFT JOIN booth_ratings r ON r.checkin_id = ci.id
WHERE ci.user_id=? AND ci.event_id=? AND ci.id <> ? AND r.id IS NULL
ORDER BY ci.checked_in_at DESC
LIMIT 1
```

「直前1件」に限定しないのは、**一度スキップした評価を永久に取り逃さないため**である。

- **カード外訪問の評価も同じように求める。** 分岐にカード内外の条件を入れない
  （[D-17](../01-concept/decisions.md)）
- 最後の1件は構造上取り逃す。マスのタップから手動評価できる導線を用意し
  `context='MANUAL'` で記録する

## 段階数

- `RATING_SCALE`（環境変数、既定 **4**）
- サーバーは `1 <= rating <= RATING_SCALE` を検証する
- 記録時に `booth_ratings.scale` へ**その時点の段階数**を入れる。
  途中で設定を変えても分析側で正規化できる
- 段階数はフロントにも伝える。カード取得 API のレスポンスに `rating_scale` を含める

## API

既存の `POST /events/:event_id/checkins/:checkin_id/rating` をそのまま使う。

```json
{ "rating": 3, "comment": "任意", "context": "NEXT_CHECKIN" }
```

- `context` は `NEXT_CHECKIN` / `MANUAL`。省略時は `MANUAL`
- コメントは空文字・空白のみなら `NULL` に正規化する
- 既存の重複チェック（`UNIQUE (checkin_id)`、INSERT 前 SELECT）は維持する

## 監視

**当日、回収率をリアルタイムで見られるようにする。** 回収率が想定を大きく下回った場合、
その日のうちに打てる手は無いが、**推薦のフェーズ切替がいつ起きるかの予測**と、
分析設計を後から調整する判断材料になる。

運営ダッシュボードに以下を出す。

- チェックイン件数 / 評価件数 / 回収率
- **現在のフェーズ**（COVERAGE / SIMILARITY / DRSA）と、次のフェーズまでの残り件数

## テストで固定すること

- 未評価のチェックインがあるとき `pending_rating` が返る
- 今まさに作ったチェックイン自身は `pending_rating` にならない
- カード外訪問でも `pending_rating` に含まれる
- `rating` が 0 または 5 のとき（`RATING_SCALE=4` の場合）422 になる
- 同じ `checkin_id` への2回目の評価は 409 になる
- `booth_ratings.scale` に 4 が入る
