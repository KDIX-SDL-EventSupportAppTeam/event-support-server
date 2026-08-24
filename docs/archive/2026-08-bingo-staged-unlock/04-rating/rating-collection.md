# 評価収集（P0 — 理論の成立条件）

**これは UX 改善ではない。** 評価の回収率が DRSA 決定表の件数を決め、決定表の件数が使える条件属性の個数を決める（[background.md](../01-concept/background.md) 7）。回収率が上がらなければ推薦手法そのものが成立しない。**最優先で実装すること。**

## 設計

**独立した評価画面を作らない。チェックイン処理のモーダル内に組み込む。**

「後で評価してね」に依存すると回収率は3割を切る（去年のアワード投票確定率 36.4% が基礎値）。次のブースで QR を読んだ瞬間に、**前のブースの評価を1タップで聞く**。行動の流れに埋め込まれるため回収率が跳ね上がり、記憶も新しい。

## サーバー側の責務

チェックイン API のレスポンスに `pending_rating` を含める。

```json
"pending_rating": { "checkin_id": "…", "booth_id": "…", "booth_name": "…" } | null
```

**算出規則（[D-10](../01-concept/decisions.md)）:** そのユーザー・そのイベントの中で、`booth_ratings` がまだ無いチェックインのうち `checked_in_at` が最新のもの。**今まさに作成したチェックイン自身は除く。**

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

- **カード外訪問の評価も同じように求める。**分岐にカード内外の条件を入れないこと（[D-12](../01-concept/decisions.md)）
- 最後の1件は構造上取り逃す。マスのタップから手動評価できる導線を用意し `prompt_context='MANUAL'` で記録する

## 段階数

- `RATING_SCALE`（環境変数、既定 **3**）。`src/config.ts` に追加する
- サーバーは `1 <= rating <= RATING_SCALE` を検証する。`booth_ratings.rating` の `CHECK (1..5)` は削除済み
- 記録時に `booth_ratings.scale` へ**その時点の段階数**を入れる。途中で設定を変えても分析側で正規化できる
- 段階数はフロントにも伝える必要がある。`GET /events/:event_id/bingo/card` のレスポンスに `rating_scale` を含める（[06-api](../06-api/participant-api.md)）

3段階を既定にした理由（[D-9](../01-concept/decisions.md)）:
- ブース関係者が目の前にいる状況では1〜2が押されず、5段階は実質4と5の2値になる
- 評価が付くのは約364件しかなく、5段階だとグレードあたりの件数が枯れる

## API

既存の `POST /events/:event_id/checkins/:checkin_id/rating` を拡張する。リクエストに `context` を追加。

```json
{ "rating": 3, "context": "NEXT_CHECKIN" }
```

`context` は `NEXT_CHECKIN` / `MANUAL` のいずれか。**省略時は `MANUAL`。**
退場時アンケートの導線は存在しないため `EXIT` は用意しない。
既存の重複チェック（`UNIQUE (checkin_id)`、INSERT 前 SELECT）はそのまま維持する。

## 監視

**当日、回収率をリアルタイムで見られるようにすること。**回収率が想定を大きく下回った場合、その日のうちに打てる手は無いが、分析設計（条件属性の個数）を後から調整する判断材料になる。運営ダッシュボードに「チェックイン件数 / 評価件数 / 回収率」を出す。
