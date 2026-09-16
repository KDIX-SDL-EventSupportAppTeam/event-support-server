---
状態: 確定
最終更新: 2026-09-01
---

# ダッシュボードの変更と、契約の不一致修正

## 1. 独自フェーズ計算の廃止

`GET /api/v1/admin/events/:event_id/dashboard` の応答から、
**サーバーが自分で計算していたフェーズ情報を外す。**

### 外すもの

```
bingo.recommender.current_phase        ← determinePhase(評価件数) の結果。嘘になりうる
bingo.recommender.next_threshold
bingo.recommender.remaining_to_next
```

これらは [01-ops-state-relay.md](01-ops-state-relay.md) の中継エンドポイントが返す。

### 残すもの（サーバーが持つべき事実）

```
bingo.checkins                     参加者のチェックイン数
bingo.ratings                      参加者の評価数
bingo.rating_collection_rate       評価回収率  ← 最重要指標。ここが正本
bingo.unlocks.{first,second,third} 解放の到達人数
bingo.fallback_rate_last_30min     直近30分のフォールバック率
```

**これらは DB の事実であり、推薦エンジンに聞く必要がない。**
`decision_table_size` だけは両方に出るが、意味が違う。

| どこ | 意味 |
|---|---|
| `bingo.ratings`（サーバー） | DB 上の評価件数。**今この瞬間の事実** |
| `state.snapshot.decision_table_size`（推薦） | **推薦エンジンが最後に取り込めた件数。**最大5分古い |

**この差は隠さない。** 画面には両方出し、「取り込み待ち」が見えるようにする
（frontend 側の仕様: `event-support-frontend/docs/specs/admin-live-monitoring/`）。

### `determinePhase` の扱い

`src/lib/bingo/phases.ts` の `determinePhase` は**解放処理でも使われている**
（推薦が応答しなかったときのフォールバック時に `phase` を埋める）。**関数は消さない。**
消すのは「運営ダッシュボードがそれを呼ぶこと」だけである。

## 2. 解放到達人数の算出式を仕様に固定する

現在の実装は「累計ペア数 1 / 3 / 6 以上」で1回目 / 2回目 / 3回目を数えている。
**この式の根拠が仕様書に無い。**

[unlock-pairs.md](../bingo-dynamic-unlock/03-card-lifecycle/unlock-pairs.md) の対応表では、
中央マスが 2 / 3 / 4 個埋まった時点で成立ペアが累計 1 / 3 / 6 組になる。
**実装は正しい。** 本仕様でこれを確定とし、[admin-api.md](../bingo-dynamic-unlock/06-api/admin-api.md) にも明記する。

| 表示 | 条件 | 意味 |
|---|---|---|
| 1回目到達 | 累計ペア数 >= 1 | 中央2マスが埋まった |
| 2回目到達 | 累計ペア数 >= 3 | 中央3マスが埋まった（2組同時成立） |
| 3回目到達 | 累計ペア数 >= 6 | 中央4マスすべてが埋まった |

**`pair_key = 'PRESURVEY'` は数えない**（事前推薦マスは解放ではない）。実装済みの挙動と一致する。

## 3. 推薦レスポンス契約の不一致修正

**`recommendation_scores.rank_in_event` が常に NULL になる不具合がある。**

| どちら | フィールド名 |
|---|---|
| 契約（[contract.md](../bingo-dynamic-unlock/05-recommender/contract.md)。**このリポジトリが正本**） | `rank` |
| 推薦エンジンの実装 | `rank_in_event` |
| サーバーの `parseScore` | `o.rank` しか見ない |

推薦エンジンを結線した瞬間から、**順位が1件も記録されなくなる。**
研究データの静かな欠損なので、結線より先に直す。

### 決定

- **推薦エンジン側を契約に合わせる**（`rank` を返す）。契約が正本であるため
- **サーバー側は両方を受ける**（`rank` を優先し、無ければ `rank_in_event` を見る）。
  デプロイ順序が前後しても壊れないようにするための保険
- `assigned[]` にも契約どおり `score` / `rank` を含める。
  サーバーは現在 `scores` から引き直しているので実害は無いが、契約とのズレは残さない

## 4. `docs/reference/` の追随

以下は事実の記述であり、実装と一緒に更新する。

- `environment-variables.md` — `RECOMMENDER_OPS_TOKEN` / `RECOMMENDER_STATE_TIMEOUT_MS` を追加
- `api-endpoints.md` — 中継エンドポイントを追加、`dashboard` の応答変更を反映
- `database.md` — **「20テーブル・増分9ファイル」は誤り。実際は 21 テーブル・12 ファイル**
