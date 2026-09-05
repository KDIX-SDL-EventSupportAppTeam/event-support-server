---
状態: 確定
最終更新: 2026-09-05
---

# 本番DBへのスキーマ適用（先生への依頼を含む）

**本番（さくら）へのスキーマ適用は、phpMyAdmin から SQL を流す以外に経路が無い。**
この文書はその手順と、先生にお願いする内容をまとめたものである。

## なぜ自動化できないのか

| 手段 | 使えない理由 |
|---|---|
| `npm run db:migrate` | **`DATABASE_URL` の直接接続専用。** さくらプロキシ経由では実行できず、スクリプト自身が拒否して終了する。さらに**空のDBにしか実行できない**（既存テーブルが1つでもあれば中断） |
| さくらプロキシ経由 | **1リクエスト = 1SQL。** マルチステートメントを流せない |
| MySQL への直接接続 | さくら Standard が外部接続を許さない |

したがって、**さくらの phpMyAdmin を開ける人（先生）に実行してもらう**必要がある。

## 適用するもの

**`db/create-tables.sql` を1本流す（作り直し方式）。**

このファイルは増分ではなく**完全な正本**であり、以下をすべて含む。

- 21 テーブル
- `gacha_settings` / `gacha_coin_uses`（ユニーク制約つき）
- `users.onboarding_completed_at`
- `card_unlock_events.pair_key VARCHAR(16)`（`'PRESURVEY'` の9文字が入る幅）
- `recommendation_scores`（旧 `recommendations` は廃止済み）

### 増分適用を選ばない理由

本番のさくら DB には `09_bingo_staged_unlock.sql` 以降が適用されておらず（各ファイル冒頭の注記）、
どこまで当たっているかを人手で確かめてから足りない分だけ流す、という運用になる。
**当日データを取り直せないイベントの前に、適用状態の判断を人に委ねる運用は取らない。**
正本 1 本（`db/create-tables.sql`）を流し、確認クエリ 3 本で結果を判定する。
`db/migrations/` の番号と適用順は [db/migrations/README.md](../../db/migrations/README.md) に固定してある（issue #112）。

## ⚠️ 破壊的である

**`db/create-tables.sql` の冒頭には `DROP TABLE IF EXISTS` が並ぶ。実行すると既存データは消える。**

本番DBには第3回（2025年）以前のデータは入っていないが、
**開発中に投入したテストデータや、事前アンケートの回答が入っている可能性がある。**
実行前に必ずダンプを取る。

## 手順

### 1. 事前ダンプ（先生・必須）

phpMyAdmin の「エクスポート」から、対象DBを**全テーブル・構造とデータの両方**で
SQL 形式で書き出し、手元に保存する。

**これが唯一のロールバック手段である。** ダンプを取らずに次へ進まない。

### 2. 適用（先生）

phpMyAdmin の「SQL」タブに `db/create-tables.sql` の中身を貼り、実行する。

- ファイル中の `USE <DB名>;` の行は、**phpMyAdmin で対象DBを選んでから実行する場合は削除する**
  （選択中のDBと衝突するため）
- 実行は1回。エラーが出たら**そこで止めて連絡する**。途中まで流れた状態で追加実行しない

### 3. 確認（先生。3つのクエリを流して結果を返す）

```sql
-- (1) テーブルが 21 個できていること
SELECT COUNT(*) AS tables FROM information_schema.tables
 WHERE table_schema = DATABASE();

-- (2) pair_key の幅が 16 であること
SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'card_unlock_events' AND column_name = 'pair_key';

-- (3) ガチャの設定テーブルができていること
SELECT COUNT(*) AS ok FROM information_schema.tables
 WHERE table_schema = DATABASE() AND table_name = 'gacha_settings';
```

期待値: (1) `21` / (2) `16` / (3) `1`

### 4. ロールバック（問題が起きたときだけ）

1 で取ったダンプを phpMyAdmin の「インポート」から流し戻す。
**それ以外の復旧手段は無い。**

## 実行のタイミング

| 対象 | いつ | 備考 |
|---|---|---|
| リハーサル用イベントのDB | リハーサルの前 | 本番と**別のDB**で先に手順を通す |
| 本番DB | イベント前日 | 当日の朝は行わない（失敗したとき戻す時間が無い） |

**本番より先に、必ずリハーサル側で1回通す。** 手順書の誤りはそこで見つける。

## 先生にお願いすること（まとめ）

1. 適用前に**全テーブルのダンプ**を取って保存する
2. phpMyAdmin の SQL タブで `db/create-tables.sql` を1回実行する
3. 確認クエリ3本を流し、結果（21 / 16 / 1）を返す
4. エラーが出たら**そこで止めて連絡する**

所要は5〜10分。`db/create-tables.sql` は本リポジトリの `db/` にある。

## 起きてはいけないこと

- **ダンプを取らずに実行すること**
- **エラーの後に追い実行すること。** 半分だけ適用された状態が最も復旧しにくい
- **当日の朝に実行すること**
- **本番DBでリハーサルを行うこと**（`docs/specs/bingo-dynamic-unlock/00-must-do.md`）
