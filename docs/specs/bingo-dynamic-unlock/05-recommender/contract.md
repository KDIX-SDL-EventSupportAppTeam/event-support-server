---
状態: 実装済み
最終更新: 2026-08-25
---

# 推薦サービスとの契約

**このファイルが `event-support-recommender` との HTTP 契約の正本である。**
推薦エンジン側のリポジトリはここへリンクし、内容をコピーしない。

アルゴリズム本体（DRSA の実装）は推薦エンジン側の関心事であり、本仕様書の範囲外。
**サーバー側は呼び出し口とフォールバックだけを持つ。**

## なぜ別サービスなのか

- 実装言語が違う（Python / TypeScript）
- デプロイ単位が別（推薦は状態を持たないので複数インスタンス化できる）
- 分析（`event-support-analytics`）と同じ言語で、**特徴量の計算コードを共有できる**。
  「分析で使った定義と本番の推薦が違う」という研究上まずい事故を構造で防ぐ

判断の記録は [ADR 0004](../../../decisions/adrs/0004-split-recommender-repository.md)。

## エンドポイント

```
POST {RECOMMENDER_URL}/recommend/cells
```

`RECOMMENDER_URL` が未設定・空文字なら**呼び出さず即フォールバックする**。

## リクエスト

```json
{
  "event_id": "…",
  "user_id": "…",
  "cell_count": 4,
  "visited_booths": [
    { "booth_id": "…", "order": 0, "source": "FREE_VISIT", "rating": 3, "rating_scale": 4 },
    { "booth_id": "…", "order": 1, "source": "PRESURVEY",  "rating": null, "rating_scale": 4 }
  ],
  "pre_survey": {
    "age_group": "twenties",
    "occupation": "student",
    "interest_categories": ["<category_id>", "<category_id>"],
    "…": "…"
  },
  "exclude_booth_ids": ["…"],
  "candidate_booths": [
    { "booth_id": "…", "category_id": "…", "visitor_count": 12 }
  ]
}
```

| フィールド | 説明 |
|---|---|
| `cell_count` | 必要なブース数。1回の解放で 2 / 4 / 6 のいずれか |
| `visited_booths` | 訪問順。`source` で事前推薦マスと自由訪問を区別できる |
| `rating` | 未評価なら `null`。**0〜3件しか付かないことを前提にする** |
| `pre_survey` | 未回答なら `null` または空オブジェクト。**未回答でも 200 を返せること** |
| `exclude_booth_ids` | 既にカードに載っている・訪問済み・中止のブース |
| `candidate_booths` | 除外後の候補。**全候補にスコアを付けて返してもらうため**に渡す |

## レスポンス

```json
{
  "phase": "DRSA",
  "decision_table_size": 214,
  "assigned": [
    { "booth_id": "…", "score": 0.82, "rank": 1 }
  ],
  "scores": [
    {
      "booth_id": "…",
      "score": 0.82,
      "rank": 1,
      "interest_match": "MATCH",
      "attributes": { "preference_match": 3, "rating_affinity": 3 },
      "reason": { "rule_id": "R12", "…": "…" }
    }
  ]
}
```

| フィールド | 説明 |
|---|---|
| `phase` | 推薦側が判定したフェーズ（[phases.md](phases.md)）。サーバーはそのまま記録する |
| `decision_table_size` | 推薦時点の決定表の件数。そのまま記録する |
| `assigned` | マスに載せるブース。最大 `cell_count` 件。**足りなくてもよい** |
| `scores` | **候補すべて**のスコア。[D-10](../01-concept/decisions.md) の記録に使う |
| `interest_match` | 事前アンケートの関心分野との一致（`MATCH` / `PARTIAL` / `MISMATCH` / `UNKNOWN`） |
| `attributes` | 条件属性の値。**推薦時点の値**。サーバーは中身を解釈せずそのまま保存する |
| `reason` | 自由な JSON。そのまま保存する。**UI には出さない**（[D-6](../01-concept/decisions.md)） |

## 条件属性（推薦エンジン側の設計）

サーバーはこれらを解釈しないが、契約の理解のために記す。すべて
**(参加者, ブース) のペアの特徴**であり、順序を持つ。

| 属性 | 値 | 材料 |
|---|---|---|
| 選好一致度 | 3 = 宣言した興味と一致 かつ 初期訪問と同ジャンル / 2 = どちらか一方 / 1 = 不一致 / 0 = 明確に避けている | 事前アンケート＋初期訪問＋ブースのカテゴリ |
| 評価履歴との親和度 | 3 = 高評価ブースと同ジャンル / 2 = 無関係 / 1 = 低評価ブースと同ジャンル | その人の評価履歴＋ブースのカテゴリ |
| （予備）参加者属性 | 年代・性別など | 事前アンケート |

**混雑度は条件属性に入れない。** 評価の予測力が弱く、実質は人気度の裏返しであるため。
同スコアの候補を並べ替えるときの基準としてのみ使う（空いているほうを優先）。

`knowledge_level` / `duration_band` は使わない（[D-12](../01-concept/decisions.md)）。

**属性の構成は後から変更する前提**とし、推薦エンジン側の1モジュールに閉じ込める。
去年のデータで年代・性別の妥当性を検証してから確定する
（[09-open-questions](../09-open-questions/open-questions.md) Q-1）。

## 呼び出し側の実装要件

| 要件 | 内容 |
|---|---|
| タイムアウト | `RECOMMENDER_TIMEOUT_MS`（既定 **1000**）で `AbortController` により中断 |
| 失敗時 | 例外を上げず[フォールバック](fallback.md)へ。**解放そのものは必ず成功させる** |
| 重複除去 | 返却された `booth_id` の重複・`exclude_booth_ids` との重複を除去する。**推薦側を信用しない** |
| 不足補完 | `cell_count` に満たない分をフォールバック規則で補い、`strategy='FALLBACK_COVERAGE'` で記録 |
| 検証 | 存在しない `booth_id` / `is_active=0` のブースは捨てる |
| 記録 | `scores` を `recommendation_scores` へ全件 INSERT する。1回の複数行 INSERT にまとめる |

**推薦サービスの応答を検証せずに DB へ書かないこと。**
`bingo_cells` の `UNIQUE (card_id, booth_id)` に当たって解放処理全体が失敗するのが最悪である。

## 規則生成のキャッシュ（推薦エンジン側）

解放が最大3回に増えたため、**呼び出しのたびに決定表を作り直すと間に合わない。**
DRSA の規則は全体データから作るもので参加者ごとに変わらないので、
推薦エンジン側で**一定間隔（例: 5分）でキャッシュする**。

個々のリクエストでは「キャッシュ済みの規則を、その参加者の候補に当てはめる」だけにする。

## スタブ実装

推薦エンジンが未実装の間は、**サーバー側でフォールバックが常に走る状態で正常に動く**こと。
`RECOMMENDER_URL` 未設定のまま結合テストが通ることを確認する。
