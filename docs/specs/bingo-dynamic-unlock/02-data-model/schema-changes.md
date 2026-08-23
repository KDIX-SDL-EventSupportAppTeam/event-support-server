---
状態: 確定
最終更新: 2026-08-24
---

# スキーマ変更

現行のテーブル構成は [reference/database.md](../../../reference/database.md) を参照。
**本ファイルはビンゴ動的段階解放に必要な差分のみを定義する。**

## 変更の全体像

| 種別 | 対象 | 内容 |
|---|---|---|
| 変更 | `bingo_cards` | `status` を削除（[D-8](../01-concept/decisions.md)） |
| 変更 | `bingo_cells` | `state` を `is_revealed` / `is_achieved` へ分解、`source` に `PRESURVEY` を追加 |
| 新規 | `card_unlock_events` | 解放の履歴（追記専用） |
| 新規 | `recommendation_scores` | 推薦度（追記専用・全候補） |
| 新規 | `gacha_coin_uses` | ガチャコインの消費記録 |
| 削除 | `recommendations` | 廃止（[D-11](../01-concept/decisions.md)）。**既存データも削除する** |
| 削除 | `cell_assignment_logs` | `recommendation_scores` へ統合 |

テーブル数 **18 → 21**。

---

## bingo_cards（変更）

```sql
CREATE TABLE bingo_cards (
  id          CHAR(36) PRIMARY KEY,
  event_id    CHAR(36) NOT NULL,
  user_id     CHAR(36) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_card_event_user (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);
```

- `status` と `unlocked_at` を**削除する**。カードの進み具合はマスから導出する（[D-8](../01-concept/decisions.md)）
- 「解放が何回起きたか」は `card_unlock_events` を数える

## bingo_cells（変更）

```sql
CREATE TABLE bingo_cells (
  id           CHAR(36)   PRIMARY KEY,
  card_id      CHAR(36)   NOT NULL,
  position     TINYINT    NOT NULL,
  zone         ENUM('CENTER','OUTER') NOT NULL,
  booth_id     CHAR(36)   NULL,
  is_revealed  TINYINT(1) NOT NULL DEFAULT 0,
  is_achieved  TINYINT(1) NOT NULL DEFAULT 0,
  source       ENUM('PRESURVEY','FREE_VISIT','RECOMMEND') NULL,
  assigned_at  DATETIME   NULL,
  achieved_at  DATETIME   NULL,
  UNIQUE KEY uq_cell_card_position (card_id, position),
  UNIQUE KEY uq_cell_card_booth (card_id, booth_id),
  FOREIGN KEY (card_id)  REFERENCES bingo_cards(id) ON DELETE CASCADE,
  FOREIGN KEY (booth_id) REFERENCES booths(id)      ON DELETE RESTRICT
);
```

`position` は 0..15 の行優先。番号の対応は [glossary.md](../01-concept/glossary.md) を参照。

### 2軸の意味（[D-9](../01-concept/decisions.md)）

| is_revealed | is_achieved | 意味 | 発生する場面 |
|---|---|---|---|
| 0 | 0 | **見えない。** 中身も持たない | 外周マスの初期状態 |
| 1 | 0 | **見えるが未訪問。** ブースが決まっている | 事前推薦マス、解放直後の推薦マス |
| 1 | 1 | 達成済み | チェックイン後 |
| 0 | 1 | **ありえない** | — |

### 不変条件（実装で必ず守る）

1. `is_achieved = 1` なら必ず `is_revealed = 1` かつ `booth_id IS NOT NULL`
2. `is_revealed = 0` のマスの `booth_id` は **API で返さない**。解放前に中身を漏らさない
3. 中央マスは `booth_id` が決まった時点で必ず `is_revealed = 1`
4. `position` 0..15 がカードごとに1つずつ、ちょうど16行

### source の意味

| 値 | 意味 |
|---|---|
| `PRESURVEY` | 事前アンケートから決めた推薦。position 5 のみ |
| `FREE_VISIT` | 参加者が自由に訪問した結果で埋まった。中央マスのみ |
| `RECOMMEND` | 解放時に推薦で割り当てられた。外周マスのみ |

旧 `SIGNUP_BONUS` は廃止（[D-1](../01-concept/decisions.md)）。

## card_unlock_events（新規・追記専用）

1回の解放につき1行。**1枚のカードにつき最大3行。**

```sql
CREATE TABLE card_unlock_events (
  id                   CHAR(36)    PRIMARY KEY,
  card_id              CHAR(36)    NOT NULL,
  pair_key             VARCHAR(8)  NOT NULL,
  line_index           TINYINT     NOT NULL,
  released_positions   VARCHAR(16) NOT NULL,
  phase                VARCHAR(16) NOT NULL,
  strategy             VARCHAR(32) NOT NULL,
  decision_table_size  INT         NULL,
  global_checkin_count INT         NOT NULL,
  created_at           DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_unlock_card_pair (card_id, pair_key),
  FOREIGN KEY (card_id) REFERENCES bingo_cards(id) ON DELETE CASCADE
);
```

| 列 | 内容 |
|---|---|
| `pair_key` | 中央ペアを表す文字列。小さい position を先にする（例: 5-6） |
| `line_index` | 成立したビンゴ列の添字（[unlock-pairs.md](../03-card-lifecycle/unlock-pairs.md)） |
| `released_positions` | 開放した外周マスの position をカンマ区切りで（例: 4,7） |
| `phase` | 推薦戦略の段階。COVERAGE / SIMILARITY / DRSA |
| `decision_table_size` | 推薦時点の決定表の件数。データ量と精度の関係を後から分析するため |
| `global_checkin_count` | 推薦時点のイベント全体の累計チェックイン数 |

**`UNIQUE (card_id, pair_key)` が解放の冪等性の要**（[D-15](../01-concept/decisions.md)）。
同じペアで解放処理が2回走っても行は1つしかできない。

## recommendation_scores（新規・追記専用）

1回の解放につき、除外されていない**全候補ブース**を1行ずつ記録する（[D-10](../01-concept/decisions.md)）。

```sql
CREATE TABLE recommendation_scores (
  id               CHAR(36)   PRIMARY KEY,
  unlock_event_id  CHAR(36)   NOT NULL,
  user_id          CHAR(36)   NOT NULL,
  booth_id         CHAR(36)   NOT NULL,
  score            DOUBLE     NULL,
  rank_in_event    SMALLINT   NULL,
  was_assigned     TINYINT(1) NOT NULL DEFAULT 0,
  interest_match   ENUM('MATCH','PARTIAL','MISMATCH','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  attributes       JSON       NULL,
  reason_payload   JSON       NULL,
  created_at       DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_score_event_booth (unlock_event_id, booth_id),
  INDEX idx_score_user (user_id),
  FOREIGN KEY (unlock_event_id) REFERENCES card_unlock_events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)         REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (booth_id)        REFERENCES booths(id) ON DELETE CASCADE
);
```

| 列 | 内容 |
|---|---|
| `score` | 推薦度。フォールバック時は NULL |
| `rank_in_event` | その解放での順位（1 が最上位） |
| `was_assigned` | マスに載ったか。**0 の行がセレンディピティ分析の分母になる** |
| `interest_match` | 事前アンケートの関心分野との一致。**推薦時点の判定を凍結して保存する** |
| `attributes` | 条件属性の値。**推薦時点の値を凍結して保存する** |
| `reason_payload` | 推薦理由。UI には出さない（[D-6](../01-concept/decisions.md)） |

`interest_match` と `attributes` を凍結するのは、カテゴリを運営が当日でも編集できるためである。
後から再計算すると値がずれ、分析が再現できなくなる。

詳細な要件は [07-research-logging/serendipity-data.md](../07-research-logging/serendipity-data.md)。

### データ量の見積もり

参加者1人あたり 3回 × 約40ブース = 約120行。250人で **3万行**。
MySQL にとって負担にならない規模である。

## gacha_coin_uses（新規）

ガチャは後から実装するが、ビンゴ側と切り離すためにテーブルだけ先に用意する
（[D-5](../01-concept/decisions.md)）。

```sql
CREATE TABLE gacha_coin_uses (
  id        CHAR(36) PRIMARY KEY,
  event_id  CHAR(36) NOT NULL,
  user_id   CHAR(36) NOT NULL,
  used_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_gacha_event_user (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);
```

## booth_ratings（スキーマ変更なし・設定のみ）

段階数を 3 から **4** に変更する（[D-7](../01-concept/decisions.md)）。
`CHECK (1..5)` は削除済み、`scale` 列も存在するのでスキーマ変更は不要。

- `RATING_SCALE` の既定値を `4` にする
- サーバーは `1 <= rating <= RATING_SCALE` を検証する
- 記録時に `scale` へその時点の段階数を入れる運用は維持する

## recommendations（削除）

```sql
DROP TABLE IF EXISTS recommendations;
```

**既存データも一緒に消える。これは意図的である**（[D-11](../01-concept/decisions.md)）。

## cell_assignment_logs（削除）

`recommendation_scores` に統合する。マスへの割当は
`bingo_cells.source` と `recommendation_scores.was_assigned` で追える。
