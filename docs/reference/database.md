---
状態: 実装済み
最終更新: 2026-08-24
---

> **現状の事実を記録する文書。** 「これからどうするか」は [../specs/](../specs/README.md) を見ること。

# データベース

完全なスキーマの正は `db/create-tables.sql`（**18 テーブル**）。増分は `db/migrations/`（9 ファイル）。  
起動手順・Docker init と `db:migrate` の使い分けは [README.md § ローカル開発](./README.md#ローカル開発) を参照。  
設計の解説は [docs/archive/legacy/designs/database.md](./docs/archive/legacy/designs/database.md)、ビンゴ段階解放方式の設計は [docs/archive/2026-08-bingo-staged-unlock/](./docs/archive/2026-08-bingo-staged-unlock/README.md) を参照。

```bash
# テーブル数確認
docker exec -it event-support-mysql \
  mysql -u app -pappsecret event_support \
  -NBe "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='event_support';"
# 18 が返ること
```

### ビンゴカード段階解放方式（追加分）

`bingo_cards` / `bingo_cells` / `cell_assignment_logs` の3テーブルを追加。既存 `booths` に `is_active` / `duration_band` / `knowledge_level`、`check_ins` に `visit_order` / `cell_id`、`booth_ratings` に `prompt_context` / `scale` を追加（`rating` の `CHECK` は削除）。関連の環境変数: `RATING_SCALE`（既定3）・`CHECKIN_COOLDOWN_SEC`（既定0=無効）・`RECOMMENDER_TIMEOUT_MS`（既定1500）。詳細は [docs/archive/2026-08-bingo-staged-unlock/02-data-model/schema-changes.md](./docs/archive/2026-08-bingo-staged-unlock/02-data-model/schema-changes.md)。

さくら等への引き渡し時: `db/create-tables.sql` を渡す（先頭の `USE` を実 DB 名に書き換えて全文実行）。
