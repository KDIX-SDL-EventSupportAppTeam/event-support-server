# db/migrations/ — 増分 DDL の置き場

## 番号規則

- ファイル名は `NN_<内容>.sql`。**`NN` は 2 桁・一意**。辞書順 ＝ 適用順。
- 新しいファイルは **既存の最大番号 + 1**（現在の最大は `12`。次は `13_`）。
- 番号を飛ばさない。同じ番号を 2 つ作らない（2026-09 に `10_` が 2 つあった事故の再発防止。issue #112）。
- 作成したら `db/create-tables.sql`（空 DB 向けの正本・21 テーブル）にも同じ定義を反映する。片方だけ直すと docker 初期化と本番でスキーマが割れる。

## 適用順（2026-09 時点）

| 順 | ファイル | 依存 |
|---|---|---|
| 01 | `01_initial_schema.sql` | — |
| 02 | `02_add_user_role.sql` | 01 |
| 03 | `03_organizer_self_management.sql` | 01 |
| 04 | `04_booth_categories.sql` | 01 |
| 05 | `05_exhibitor_booths.sql` | 01, 02 |
| 06 | `06_booth_rating_comments.sql` | 01 |
| 07 | `07_email_verification.sql` | 01 |
| 08 | `08_event_survey_url.sql` | 01 |
| 09 | `09_bingo_staged_unlock.sql` | 01 |
| 10 | `10_gacha_coins.sql` | 01（`events` / `users`） |
| 11 | `11_widen_unlock_pair_key.sql` | 09（`card_unlock_events`） |
| 12 | `12_onboarding_completed.sql` | 01（`users`） |

## どの経路が何を読むか

| 経路 | 読むもの | いつ使うか |
|---|---|---|
| `docker compose up -d mysql`（初回・空ボリューム） | **このディレクトリを辞書順に全部** | ローカル開発の初回。作り直すときは `docker compose down -v` |
| `npm run db:migrate` | **`db/create-tables.sql` だけ**（このディレクトリは読まない） | Docker を使わない空 DB。テーブルが 1 つでもあれば中断する |
| 本番（さくら） | `db/create-tables.sql` を phpMyAdmin で 1 回 | `docs/operations/production-db-apply.md`。**このディレクトリは本番に流さない** |
| 既存 DB への増分 | 該当ファイルを `mysql` CLI で個別に | 開発中の手元 DB のみ |

## 再実行の注意

- `02` / `07` / `12` はストアドプロシージャで列の有無を確認するため、2 回流しても無害。
- `11` は同じ型への `MODIFY` なので 2 回流しても無害。
- **`10_gacha_coins.sql` は `gacha_coin_uses` を `DROP` してから作り直す。データの入った DB に再実行するとコイン使用台帳が消える。** 空 DB か「消してよい」と判断した DB にしか流さない。
- `09_bingo_staged_unlock.sql` も作り直し方式。同上。

## 確認コマンド

```bash
# 番号が一意で辞書順に並んでいること
ls db/migrations/*.sql | sed -E 's#.*/([0-9]+)_.*#\1#' | sort | uniq -d   # 出力が空なら OK

# docker 初期化後のテーブル数（21）
docker exec event-support-mysql mysql -uroot -pdevroot -NBe \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='event_support';"
```
