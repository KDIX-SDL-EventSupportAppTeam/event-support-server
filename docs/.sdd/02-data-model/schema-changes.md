# DB スキーマ変更

既存 13 テーブル + `event_app_access`（2026-08-17 の作業指示分）に対する追加・変更。
**主キーは全て `CHAR(36)` UUID、アプリ側 `randomUUID()` 採番**（[D-6](../01-concept/decisions.md)）。DATETIME は UTC 保存・表示時に JST(+9) 変換。

> MySQL 5.7（本番さくら）と 8.0（ローカル docker）の両方で動く DDL にすること。`ADD COLUMN IF NOT EXISTS` は 8.0 非対応なので、既存マイグレーション 02/03 と同じくストアドプロシージャで冪等化する。

---

## 新規 1: `bingo_cards`

```sql
CREATE TABLE bingo_cards (
  id          CHAR(36) PRIMARY KEY,
  event_id    CHAR(36) NOT NULL,
  user_id     CHAR(36) NOT NULL,
  status      ENUM('CENTER_ONLY','UNLOCKED') NOT NULL DEFAULT 'CENTER_ONLY',
  unlocked_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_card_event_user (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);
```

`UNIQUE (event_id, user_id)` により、複数端末ログインでも同じカードが返る（E8）。

## 新規 2: `bingo_cells`

1カードにつき**必ず16行**を作る。

```sql
CREATE TABLE bingo_cells (
  id          CHAR(36) PRIMARY KEY,
  card_id     CHAR(36) NOT NULL,
  position    TINYINT  NOT NULL,             -- 0..15（行優先）
  zone        ENUM('CENTER','OUTER') NOT NULL,
  booth_id    CHAR(36) NULL,                 -- 未確定は NULL
  state       ENUM('LOCKED','EMPTY','ACHIEVED') NOT NULL,
  source      ENUM('SIGNUP_BONUS','FREE_VISIT','RECOMMEND') NULL,
  assigned_at DATETIME NULL,                 -- booth_id が確定した時刻
  achieved_at DATETIME NULL,                 -- 達成した時刻
  UNIQUE KEY uq_cell_card_position (card_id, position),
  UNIQUE KEY uq_cell_card_booth (card_id, booth_id),
  FOREIGN KEY (card_id)  REFERENCES bingo_cards(id) ON DELETE CASCADE,
  FOREIGN KEY (booth_id) REFERENCES booths(id)      ON DELETE RESTRICT
);
```

- `uq_cell_card_booth` は同一ブースが2マスに入らないことを保証する。**NULL は重複可**なので未確定マスが並んでも問題ない
- `CENTER` の `position` は **5, 6, 9, 10**。それ以外の12個が `OUTER`
- FK は `RESTRICT`。割当済みブースの物理削除を防ぐ（中止は `is_active=0` で表す。E5）

### `state` の意味

| 値 | 意味 |
|---|---|
| `LOCKED` | 外側マスの解放前。**API は booth を返してはならない**。UI は「?」枠のみ |
| `EMPTY` | 中央マスでまだ訪問が割り当てられていない、または外側マスで解放済み未達成 |
| `ACHIEVED` | 達成済み |

### 遷移

- 中央マス: `EMPTY` → `ACHIEVED`（**`booth_id` は `ACHIEVED` になる瞬間に後出しで書き込まれる**）。ただしボーナスマスは配布時点で `ACHIEVED`
- 外側マス: `LOCKED` →（解放時に `booth_id` 確定）→ `EMPTY` → `ACHIEVED`

## 新規 3: `booth_attributes`

出展者フォームから取り込むブースの事実タグ。既存の `booth_tags` / `booth_categories` とは別物（あちらは表示用ラベル・分類）。

```sql
CREATE TABLE booth_attributes (
  booth_id        CHAR(36) PRIMARY KEY,
  genre           VARCHAR(32) NOT NULL,                          -- 8択から必ず1つ
  duration_band   ENUM('SHORT','MID','LONG') NOT NULL,           -- 〜3分 / 3-10分 / 10分〜
  knowledge_level ENUM('NONE','HELPFUL','REQUIRED') NOT NULL,    -- 不要 / あると楽しい / 前提
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE CASCADE
);
```

**出展者には「評価」ではなく「事実」だけを聞く。**盛る動機がなく、本人が確実に知っている項目に限定する。**ジャンルは必ず1つだけ。**複数選択を許すとタグ過多化が起き、ベクトル空間で全方向に近いブースが生まれて識別力が失われる。

> 未登録のブースがあっても機能は止めないこと。属性が無いブースは推薦の条件属性を評価できないだけで、割当候補からは外さない。

## 新規 4: `cell_assignment_logs`

研究・デバッグ用。[07-research-logging](../07-research-logging/logging.md) を参照。

```sql
CREATE TABLE cell_assignment_logs (
  id                   CHAR(36)    PRIMARY KEY,
  cell_id              CHAR(36)    NOT NULL,
  strategy             VARCHAR(32) NOT NULL,
  score                DOUBLE      NULL,
  reason_payload       JSON        NULL,
  global_checkin_count INT         NOT NULL,
  created_at           DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (cell_id) REFERENCES bingo_cells(id) ON DELETE CASCADE
);
```

**`global_checkin_count` は NOT NULL・省略不可。**「データ量が推薦精度を規定するか」の検証に使う中心変数である。

---

## 既存変更 1: `check_ins`

```sql
ALTER TABLE check_ins
  ADD COLUMN visit_order INT      NOT NULL DEFAULT 0,  -- そのユーザーの何件目か（1始まり）
  ADD COLUMN cell_id     CHAR(36) NULL,                -- 埋めたマス。カード外訪問は NULL
  ADD CONSTRAINT fk_checkin_cell FOREIGN KEY (cell_id) REFERENCES bingo_cells(id) ON DELETE SET NULL,
  ADD INDEX idx_checkin_event_time (event_id, checked_in_at),
  ADD INDEX idx_checkin_event_booth (event_id, booth_id);
```

- **`UNIQUE KEY uq_checkin_user_booth (user_id, booth_id)` は既存で入っている。維持する。**去年は Firestore のドキュメントIDがブースIDだったため再チェックインが構造上発生せず、これが無いと分析が壊れる
- 既存行の `visit_order` は backfill する（[migration.md](migration.md)）
- 2つの INDEX は時系列集計・混雑度算出用

## 既存変更 2: `booth_ratings`

```sql
ALTER TABLE booth_ratings
  ADD COLUMN prompt_context ENUM('NEXT_CHECKIN','MANUAL','EXIT') NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN scale          TINYINT NOT NULL DEFAULT 5;
```

- `rating` の `CHECK (rating BETWEEN 1 AND 5)` は**削除する**。段階数は `RATING_SCALE`（既定3）で切り替え、アプリ側で `1..RATING_SCALE` を検証する（[D-9](../01-concept/decisions.md)）
- `scale` にはその評価を記録した時点の段階数を入れる。既存行は5段階なので DEFAULT 5 が正しい backfill になる
- `UNIQUE KEY uq_rating_per_checkin (checkin_id)` は既存。維持

## 既存変更 3: `booths`

```sql
ALTER TABLE booths ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1;
```

当日中止になったブースを割当候補から除外するため（E5）。**論理削除であり、既に割り当て済みのマスは自動では変わらない。**運営操作で差し替える（[06-api/admin-api.md](../06-api/admin-api.md)）。

## 既存変更 4: `users`（スタッフ除外）

**新規カラムは追加しない。**既存の `users.role`（`participant` / `manager` / `viewer`）で判別できる。分析・推薦の学習データからは `role <> 'participant'` を除外する（E11）。去年は運営疑いアカウントが34ブース訪問しており分析を歪めていた。

---

## 作らないもの

| 企画書の項目 | 判断 |
|---|---|
| `pre_survey_responses` | **作らない。**既存 `survey_questions` / `user_survey_answers` を使う（[D-8](../01-concept/decisions.md)） |
| `users.is_staff` | **作らない。**既存 `users.role` を使う |
| `recommendations` テーブルの拡張 | **触らない。**本機能の割当根拠は `cell_assignment_logs` に記録する |

## テーブル数

14 → **18**（`bingo_cards` / `bingo_cells` / `booth_attributes` / `cell_assignment_logs`）。
完了後に [AGENTS.md](../../../AGENTS.md) のテーブル数とエンドポイント表を更新すること。
