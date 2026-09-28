---
状態: 実装済み
最終更新: 2026-09-23
---

# 評価収集（P0 — 理論の成立条件）

**これは UX 改善ではない。** 評価の回収率が決定表の件数を決め、決定表の件数が
DRSA を使えるかどうかを決める（[background.md](../01-concept/background.md) 7）。
回収率が上がらなければ推薦手法そのものが成立しない。**最優先で実装する。**

## 設計（2026-09 改訂: server#133）

**チェックイン直後、いま訪問したブースをその場で評価する。**「1つ前の未評価チェックインを
後追いで聞く」旧方式（`pending_rating` による NEXT_CHECKIN 方式）は廃止した。

その場で評価しなかったブースは、**あとからブース一覧・ビンゴカードから評価できる**
（入口は frontend#115）。評価済みのチェックインは再評価できない（409 `CONFLICT`）。

## UI（[D-7](../01-concept/decisions.md)）

**星4段階（中央値なし）＋ コメント入力欄 ＋「完了」ボタン1つ。**

- 5段階は中間（3）に集中しやすく、実験データとして分析しづらい
- 「評価を送信」「コメント送信」の2ボタン構成は、どちらをスキップしたか区別がつかない
- ボタンを1つにすることで、「星だけ」「星＋コメント」「何もせず閉じる」の3状態が明確になる

詳細な画面仕様はフロント側 `event-support-frontend/docs/specs/bingo-dynamic-unlock/` を参照。

## サーバー側の責務

`pending_rating` は廃止した。チェックイン API のレスポンスにこのキーは**存在しない**。

代わりに、`GET /events/:event_id/checkins` の各要素に `rated: boolean` を返す。
フロント（ブース一覧・ビンゴカード）はこれで「訪問済みで未評価」を判別し、
あとから評価する導線を出す。点数そのものはここでは返さない。

- **カード外訪問の評価も同じように求める。** 分岐にカード内外の条件を入れない
  （[D-17](../01-concept/decisions.md)）
- 評価の保存先ブースは `checkin_id` から引くため、ブースの付け替えは起きない

## 段階数

- `RATING_SCALE`（環境変数、既定 **4**）
- サーバーは `1 <= rating <= RATING_SCALE` を検証する
- 記録時に `booth_ratings.scale` へ**その時点の段階数**を入れる。
  途中で設定を変えても分析側で正規化できる
- 段階数はフロントにも伝える。カード取得 API のレスポンスに `rating_scale` を含める

## API

既存の `POST /events/:event_id/checkins/:checkin_id/rating` をそのまま使う。

```json
{ "rating": 3, "comment": "任意", "context": "IMMEDIATE" }
```

- `context` は `IMMEDIATE`（チェックイン直後）/ `MANUAL`（あとから）。省略時は `MANUAL`。
  `NEXT_CHECKIN` は新規には受け付けず 422 になる（`booth_ratings.prompt_context` の ENUM には
  既存データのために残すが、旧方式のデータ以外では出現しない）
- コメントは空文字・空白のみなら `NULL` に正規化する
- 既存の重複チェック（`UNIQUE (checkin_id)`、INSERT 前 SELECT）は維持する。評価済みの
  `checkin_id` への再評価は 409 `CONFLICT`。他人の `checkin_id` への評価は 404 `NOT_FOUND`

## 監視

**当日、回収率をリアルタイムで見られるようにする。** 回収率が想定を大きく下回った場合、
その日のうちに打てる手は無いが、**推薦のフェーズ切替がいつ起きるかの予測**と、
分析設計を後から調整する判断材料になる。

運営ダッシュボードに以下を出す。

- チェックイン件数 / 評価件数 / 回収率
- **現在のフェーズ**（COVERAGE / SIMILARITY / DRSA）と、次のフェーズまでの残り件数

## テストで固定すること

- 未評価のチェックインは `GET /checkins` で `rated: false`。評価後は `rated: true`
- 同じ `checkin_id` への2回目の評価は 409 になる（行は増えない）
- 他人の `checkin_id` への評価は 404 になる（行は作られない）
- `context: 'IMMEDIATE'` は `prompt_context = 'IMMEDIATE'` で保存される
- `context` 省略時は `'MANUAL'` で保存される
- `context: 'NEXT_CHECKIN'` は 422 になる（新規には受け付けない）
- `POST /checkins` のレスポンスに `pending_rating` キーは存在しない
- `rating` が 0 または 5 のとき（`RATING_SCALE=4` の場合）422 になる
- `booth_ratings.scale` に 4 が入る
