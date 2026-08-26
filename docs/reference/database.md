[← reference](./README.md)

このファイルは **今どうなっているか** を書く。コードが正、文書が従。
実装が変わったら追随させること（[rules/documentation.md](../rules/documentation.md)）。

---

# データベース

完全なスキーマの正は `db/create-tables.sql`（**20 テーブル**）。増分は `db/migrations/`（9 ファイル）。
起動手順・Docker init と `db:migrate` の使い分けは [README.md § ローカル開発](./README.md#ローカル開発) を参照。

```bash
# テーブル数確認
docker exec -it event-support-mysql \
  mysql -u app -pappsecret event_support \
  -NBe "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='event_support';"
# 20 が返ること

npm run db:check   # テーブルの過不足と件数をまとめて確認する
```

## ビンゴカード動的段階解放方式

仕様は [specs/bingo-dynamic-unlock/02-data-model/](../specs/bingo-dynamic-unlock/02-data-model/schema-changes.md)。

| テーブル | 役割 |
|---|---|
| `bingo_cards` | カード。**段階（status）は持たない。** 現在の姿は `bingo_cells` から導出する |
| `bingo_cells` | 16マス。状態は `is_revealed`（見えるか）/ `is_achieved`（訪問済みか）の2軸 |
| `card_unlock_events` | 解放履歴。**追記専用。** `UNIQUE (card_id, pair_key)` が冪等性の要 |
| `recommendation_scores` | 解放ごとの候補全件のスコア。追記専用 |
| `gacha_coin_uses` | ガチャの器。ビンゴ側からは書かない |

`bingo_cells.source` は `PRESURVEY` / `FREE_VISIT` / `RECOMMEND` の3値。
`is_revealed = 0` のマスの `booth_id` は **API から返さない**（解放前に中身を漏らさない）。

既存テーブルへの追加: `booths.is_active`、`check_ins.visit_order` / `cell_id`、
`booth_ratings.prompt_context` / `scale`（`rating` の `CHECK` は削除）。

削除したテーブル: `recommendations`、`cell_assignment_logs`。

### 削除順序の制約

`bingo_cells.booth_id` は `ON DELETE RESTRICT` のため、
イベントデータ全削除（`src/lib/event-data/clear-all.ts`）では
**`booths` を消す前に `bingo_cards` を削除する**。

`bingo_cells` と `card_unlock_events` は `bingo_cards` から CASCADE で消え、
`recommendation_scores` は `card_unlock_events` から CASCADE で消える。

## 事前アンケート・アプリ公開ゲート

仕様は [specs/pre-survey/02-data-model.md](../specs/pre-survey/02-data-model.md)。

| テーブル | 役割 |
|---|---|
| `event_app_access` | アプリ公開ゲート。`mode` は `closed` / `scheduled` / `open` |

**行が無いイベントは `closed` 相当として扱う。**
実効開放状態はサーバーが算出する（`src/lib/app-access.ts`）。判定ロジックはここ1箇所だけに置く。

既存テーブルへの追加: `survey_questions.answer_type` / `question_key`、
`user_survey_answers` に `UNIQUE (user_id, event_id)`。

`question_key = 'interest_categories'` の設問だけは選択肢を `options` から読まず、
`categories` テーブルから動的生成する。**この設問が無いと
`custom_answers.interest_categories` が入らず、ビンゴの事前推薦マスが空のままになる。**

## 関連する環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `RATING_SCALE` | `4` | 評価の段階数。`booth_ratings.scale` に保存する |
| `CHECKIN_COOLDOWN_SEC` | `0`（無効） | 同一ユーザーの連続チェックインを拒否する最短間隔 |
| `RECOMMENDER_TIMEOUT_MS` | `1000` | 推薦サービス呼び出しのタイムアウト |
| `RECOMMENDER_URL` | 未設定 | **未設定なら呼び出さず即フォールバック**（訪問者数の少ない順） |

全一覧は [environment-variables.md](./environment-variables.md)。

## 本番への引き渡し

`db/create-tables.sql` を渡す（先頭の `USE` を実 DB 名に書き換えて全文実行）。

本番 DB はさくらの HTTP プロキシ経由で **1 リクエスト = 1 SQL**。
トランザクションも行ロックも無い（[ADR 0001](../decisions/adrs/0001-sakura-proxy-error-masking.md)）。
排他は条件付き `UPDATE` の `affectedRows` と、追記専用テーブルの一意制約で取る。
