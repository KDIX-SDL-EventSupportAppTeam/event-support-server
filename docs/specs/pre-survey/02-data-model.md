---
状態: 実装済み
最終更新: 2026-09-10
---

# データモデル

**ビンゴ側のマイグレーションと同じタイミングで1回にまとめて実行する**
（[bingo/migration.md](../bingo-dynamic-unlock/02-data-model/migration.md)）。

## `event_app_access`（新規）

```sql
CREATE TABLE event_app_access (
  event_id             CHAR(36)     PRIMARY KEY,
  mode                 VARCHAR(20)  NOT NULL DEFAULT 'closed',
  app_opens_at         DATETIME     NULL,
  app_closes_at        DATETIME     NULL,
  pre_survey_closes_at DATETIME     NULL,
  updated_by           CHAR(36)     NULL,
  updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CHECK (mode IN ('closed', 'scheduled', 'open')),
  FOREIGN KEY (event_id)   REFERENCES events(id)     ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES organizers(id) ON DELETE SET NULL
);
```

- `event_id` を主キーにして1イベント1行を保証する
- 行が無いイベントは **`mode='closed'` 相当**として扱う（フォールバック）
- `updated_by` は変更した主催者。表示用途と監査の補助

### 既定値の投入

イベント作成時（`POST /organizer/events`）に1行を必ず作る。

| 列 | 既定値 |
|---|---|
| `mode` | `scheduled` |
| `app_opens_at` | `events.date_start` の30分前 |
| `pre_survey_closes_at` | `events.date_start` の前日 23:59:59（JST 基準で計算し保存形式に合わせる） |

マイグレーション時、既存イベントにも同じ規則で1行を backfill する（`INSERT ... SELECT`）。
過去日程のイベントは結果的に `is_open = true` になるが、実運用上問題ない。

## `survey_questions`（変更）

```sql
ALTER TABLE survey_questions
  ADD COLUMN answer_type VARCHAR(20) NOT NULL DEFAULT 'single',
  ADD COLUMN question_key VARCHAR(50) NULL,
  ADD CONSTRAINT chk_answer_type CHECK (answer_type IN ('single','multi','text'));
```

| 列 | 用途 |
|---|---|
| `answer_type` | `single`（単一選択）/ `multi`（複数選択）/ `text`（自由記述） |
| `question_key` | 設問の安定した識別子（`age_range` / `occupation` / `interest_categories` 等）。**分析側がこれで設問を特定する。** UUID の `id` は環境ごとに変わるため使えない |

### `options` の形式

離散コードを保持するため、`options` JSON の要素は
`{ "value": "twenties", "label": "20代" }` 形式に統一する。
値が文字列だけの旧データは、読み取り時に `{ value: s, label: s }` として正規化する。

### 本番の設問セット（必須5問 + 任意1問）

投入は `db/migrations/16_pre_survey_questions.sql`。
**`question_key` と `options` の `value` は分析・推薦側との契約であり、変更しない。**
`label`（表示文言）は運営の裁量で変えてよい。

| # | `question_key` | `answer_type` | 必須 | `value` |
|---|---|---|:-:|---|
| 1 | `interest_categories` | `multi` | ✅ | `categories` から動的生成（保存しない） |
| 2 | `top_interest_category` | `single` | ✅ | 同上。1 で選んだ中の第1希望 |
| 3 | `age_range` | `single` | ✅ | `teens` / `twenties` / `thirties` / `forties` / `fifties_plus` |
| 4 | `occupation` | `single` | ✅ | `student` / `engineer` / `designer` / `planner` / `other` |
| 5 | `gender` | `single` | ⬜︎ 任意 | `male` / `female` / `other` / `prefer_not_to_say` |
| 6 | `exploration_disposition` | `single` | ✅ | `low` / `mid` / `high` |

- `display_order` は上表の 1〜6
- `gender` は**層別軸としてのみ**使う。条件属性にも近傍計算にも使わない
- 要求の背景は
  [event-support-recommend の 06-pre-survey-requirements.md](../../../../event-support-recommend/docs/specs/06-pre-survey-requirements.md)

### カテゴリ由来の設問（`interest_categories` / `top_interest_category`）

この2問は **`options` を保存せず、配信時に `categories` から生成する**（[P-10](01-concept.md)）。

```json
{ "value": "<category_id>", "label": "<categories.name>" }
```

`answer_type` は `interest_categories` が `multi`、`top_interest_category` が `single`。
DB には空配列（`[]`）を入れておく。

対象キーの集合は `src/lib/survey-options.ts` の `CATEGORY_DERIVED_QUESTION_KEYS` に持つ。
**1つのキーの等値比較で分岐しない。** カテゴリ由来の設問が増えたときに片方だけ直る事故を防ぐため。

## `user_survey_answers`（変更）

```sql
ALTER TABLE user_survey_answers
  ADD UNIQUE KEY uq_user_event (user_id, event_id);
```

**1参加者1回答を保証する。** 重複 INSERT は行わず、既存行があれば UPDATE する
（プロキシがエラーを 500 に潰すため、**INSERT 前に SELECT で存在確認**する。
[ADR 0001](../../decisions/adrs/0001-sakura-proxy-error-masking.md)）。

### 列の使い方

| 列 | 用途 |
|---|---|
| `age_range` | 年代の離散コード（例 `twenties`） |
| `occupation` | 職業の離散コード（例 `student`） |
| `industry` | 業種の離散コード（無ければ NULL） |
| `custom_answers` | 上記以外すべて。`{ "<question_key>": "<value>" \| ["<value>", ...] }` |

`age_range` / `occupation` / `industry` は分析でよく使うため専用列に**併記**する
（`custom_answers` にも同じ値を入れてよい）。
どの設問をどの列へ写すかは `survey_questions.question_key` で判定する。

**関心分野は `custom_answers.interest_categories` に `category_id` の配列**として入る。
事前推薦マスの決定と、条件属性「選好一致度」の計算はここを読む。

**第1希望は `custom_answers.top_interest_category` に `category_id` 単体**で入る。
値は必ず同じ回答の `interest_categories` に含まれる（回答 POST で検証する。[06-api.md](06-api.md)）。
これにより選好一致度が「一致 / 不一致」の2段階から「第1希望 / 関心あり / 不一致」の3段階になる。

`gender` と `exploration_disposition` には専用列が無いため、`custom_answers` にのみ入る。
`industry` は本番の設問セットに対応する設問が無く、NULL のままになる。
