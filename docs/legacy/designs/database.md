# データベース設計

テーブル定義・リレーション・RDBMS の物理設計方針・将来の移行メモです。

**関連:** [設計インデックス](./README.md) · [システム・サーバー設計](./system-server.md) · [API設計](./api.md) · [フロントエンド](./frontend.md) · [ADR 0003（MySQL 採用）](../adrs/0003-mysql-over-postgresql.md)

---

## 8. RDBMS と物理レイヤの方針

| 項目 | 方針 |
|------|------|
| 製品 | **MySQL 8.x**（チーム・インフラ都合により PostgreSQL から変更） |
| ストレージエンジン | **InnoDB** を全テーブルに明示（`ENGINE=InnoDB`） |
| 主キー | **UUID をアプリケーション側で生成**し、`CHAR(36)` に `INSERT`（DBの `UUID()` / ランダム関数に依存しない） |
| 日時 | 型は **`DATETIME`** に統一。値は **UTC** で解釈し、アプリ・マイグレーション層で一貫させる |
| 既定値 | 論理は **UTC**（`DATETIME`）。**`db/migrations/01_initial_schema.sql`** では Docker 初期化の互換性のため `DEFAULT CURRENT_TIMESTAMP` / `ON UPDATE CURRENT_TIMESTAMP` を採用し、`docker-compose` の **`--default-time-zone=+00:00`** でサーバ時刻を UTC に固定する。MySQL **8.0.13+** では `DEFAULT (UTC_TIMESTAMP())` も可だが、式既定は環境によって初期化スクリプトが失敗することがある |
| 配列型の代替 | PostgreSQL の `UUID[]` / `TEXT[]` は **MySQL に無い**ため、タグは **`booth_tags` 子テーブル**、推薦の ID 列挙は **`JSON` 配列**（UUID の文字列配列）で表現する |
| 半構造化データ | PostgreSQL の `JSONB` に相当する **`JSON`** 型を使用（インデックスが必要になったら生成列 + インデックスを別途検討） |
| 制約 | `CHECK` は **MySQL 8.0.16+** で有効。本スキーマはそれを前提とする |

---

## 9. ドメイン設計方針

- イベントは1〜2日程度の短期開催を想定する
- **過去イベントのデータは参照しない**設計のため、全データは `event_id` に紐づける
- 参加者はイベントごとに別アカウントとして管理する
- 将来、過去データを横断参照する設計に移行しやすいよう、`UNIQUE(email, event_id)` を採用する
- **企画・UX由来のルール（DB 制約で担保）:** 同一参加者×同一ブースのチェックインは **1 回まで**（誤タップ・通信リトライでの二重計上を防ぐ）。評価は **チェックイン 1 回につき最大 1 件**。同一ブースに **同じタグは 1 つまで**。ブース行の **`updated_at` は行更新時に自動更新**し、フォーム連携の反映時刻を運営が追いやすくする

---

## 10. テーブル一覧

> **実装方針メモ（2026-05時点）**  
> アワード投票・ガチャコイン・ビンゴカードは初期実装に含めない。要件確定後に追加する。  
> これらを追加する際はコアテーブル（`check_ins` 等）への変更は不要で、独立したテーブルとして追加できる。

| テーブル名 | 概要 | 初期実装 |
|-----------|------|---------|
| events | イベントマスタ | ✅ |
| categories | ブースカテゴリマスタ（イベントごと） | ✅ |
| booths | ブース情報 | ✅ |
| booth_tags | ブースに付与するタグ（正規化。MySQL に配列型が無いため） | ✅ |
| users | 参加者アカウント | ✅ |
| survey_questions | イベント固有アンケート設問マスタ | ✅ |
| user_survey_answers | 参加者のアンケート回答 | ✅ |
| check_ins | チェックイン記録 | ✅ |
| booth_ratings | ブース評価記録 | ✅ |
| recommendations | 推薦ログ | ✅ |
| award_votes | アワード投票記録 | ⏳ 後から追加 |
| gacha_coins | ガチャコイン残高・消費記録 | ⏳ 後から追加 |

---

## 11. Canonical DDL（MySQL 8 / InnoDB）

設計書上の正とする DDL。実装のマイグレーションはここから生成する。**リポジトリの初期 SQL:** `db/migrations/01_initial_schema.sql`（ローカル Docker 初回起動で適用。以降の差分は番号付き SQL を追加するか、Flyway 等へ移行する）。

**採用した修正（提案 DDL からの差分）**

- `booths.manual_code` は **イベント内で一意**とし、`UNIQUE KEY uq_manual_code_event (event_id, manual_code)` とした（グローバル単独 `UNIQUE` は別イベントでコード再利用できず、6桁空間の運用とも相性が悪い）
- **企画・UXで確定した制約:** `check_ins` に `UNIQUE(user_id, booth_id)`（同一ブースへの重複チェックイン不可）、`booth_ratings` に `UNIQUE(checkin_id)`（1 チェックイン 1 評価）、`booth_tags` に `UNIQUE(booth_id, tag)`（同一タグの重複不可）。`booths.updated_at` に **`ON UPDATE CURRENT_TIMESTAMP`**（Docker ではセッション TZ が UTC のため実質 UTC で更新される）
- `booth_tags.tag` は一意インデックスの都合で **`VARCHAR(255)`** とした（極端に長いタグは設計上トリム・別表現を前提とする）
- その他は提示いただいた構造・型・削除時の `ON DELETE` 方針に沿う。実装ファイル **`db/migrations/01_initial_schema.sql`** は次の SQL ブロックと同一。DB の選択は接続 URL・`MYSQL_DATABASE`・手動の `USE` で行い、マイグレーション SQL 内には `USE` を書かない（`cd server && npm run db:migrate` が `DATABASE_URL` の DB に CREATE を実行する）。

```sql
SET NAMES utf8mb4;

CREATE TABLE events (
  id          CHAR(36)     PRIMARY KEY,
  name        TEXT         NOT NULL,
  date_start  DATETIME     NOT NULL,
  date_end    DATETIME     NOT NULL,
  venue       TEXT,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE categories (
  id        CHAR(36)  PRIMARY KEY,
  event_id  CHAR(36)  NOT NULL,
  name      TEXT      NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE booths (
  id                      CHAR(36)     PRIMARY KEY,
  event_id                CHAR(36)     NOT NULL,
  name                    TEXT         NOT NULL,
  description             TEXT,
  category_id             CHAR(36),
  manual_code             VARCHAR(6)   NOT NULL,
  qr_code_url             TEXT,
  google_form_response_id TEXT,
  created_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id)    REFERENCES events(id)     ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  UNIQUE KEY uq_manual_code_event (event_id, manual_code)
) ENGINE=InnoDB;

CREATE TABLE booth_tags (
  id        CHAR(36)      PRIMARY KEY,
  booth_id  CHAR(36)      NOT NULL,
  tag       VARCHAR(255)  NOT NULL,
  FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE CASCADE,
  UNIQUE KEY uq_booth_tag (booth_id, tag)
) ENGINE=InnoDB;

CREATE TABLE users (
  id            CHAR(36)  PRIMARY KEY,
  event_id      CHAR(36)  NOT NULL,
  email         VARCHAR(255) NOT NULL,
  password_hash TEXT,
  google_id     TEXT,
  display_name  TEXT,
  created_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_email_event (email, event_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE survey_questions (
  id             CHAR(36)  PRIMARY KEY,
  event_id       CHAR(36)  NOT NULL,
  question_text  TEXT      NOT NULL,
  options        JSON      NOT NULL,
  display_order  INT,
  is_required    BOOLEAN   DEFAULT FALSE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE user_survey_answers (
  id              CHAR(36)  PRIMARY KEY,
  user_id         CHAR(36)  NOT NULL,
  event_id        CHAR(36)  NOT NULL,
  age_range       VARCHAR(50),
  occupation      VARCHAR(100),
  industry        VARCHAR(100),
  custom_answers  JSON,
  created_at      DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE check_ins (
  id             CHAR(36)     PRIMARY KEY,
  user_id        CHAR(36)     NOT NULL,
  booth_id       CHAR(36)     NOT NULL,
  event_id       CHAR(36)     NOT NULL,
  checkin_method ENUM('qr', 'manual') NOT NULL,
  checked_in_at  DATETIME     NOT NULL,
  synced_at      DATETIME,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (booth_id) REFERENCES booths(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  UNIQUE KEY uq_checkin_user_booth (user_id, booth_id)
) ENGINE=InnoDB;

CREATE TABLE booth_ratings (
  id          CHAR(36)  PRIMARY KEY,
  user_id     CHAR(36)  NOT NULL,
  booth_id    CHAR(36)  NOT NULL,
  event_id    CHAR(36)  NOT NULL,
  checkin_id  CHAR(36)  NOT NULL,
  rating      TINYINT   NOT NULL CHECK (rating BETWEEN 1 AND 5),
  rated_at    DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)    REFERENCES users(id)      ON DELETE CASCADE,
  FOREIGN KEY (booth_id)   REFERENCES booths(id)     ON DELETE CASCADE,
  FOREIGN KEY (event_id)   REFERENCES events(id)     ON DELETE CASCADE,
  FOREIGN KEY (checkin_id) REFERENCES check_ins(id)  ON DELETE CASCADE,
  UNIQUE KEY uq_rating_per_checkin (checkin_id)
) ENGINE=InnoDB;

CREATE TABLE recommendations (
  id                 CHAR(36)  PRIMARY KEY,
  user_id            CHAR(36)  NOT NULL,
  event_id           CHAR(36)  NOT NULL,
  offered_booth_ids  JSON      NOT NULL,
  selected_booth_id  CHAR(36),
  rejected_booth_ids JSON,
  algorithm          VARCHAR(50) NOT NULL,
  created_at         DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)           REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (event_id)          REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (selected_booth_id) REFERENCES booths(id) ON DELETE SET NULL
) ENGINE=InnoDB;
```

### `recommendations` の JSON の形（論理）

- `offered_booth_ids` / `rejected_booth_ids`: UUID 文字列の JSON 配列（例: `["uuid-1","uuid-2"]`）
- `algorithm` の想定値: `content_based` / `mab` / `rough_set` / `session_based`

---

## 12. テーブル間の関係図

```
events
  ├── categories
  ├── survey_questions
  ├── booths ──────────────── categories
  │     └── booth_tags
  └── users
        ├── user_survey_answers
        ├── check_ins ───────── booths
        │     └── booth_ratings
        └── recommendations ─── booths
```

---

## 13. スキーマレビュー（確認結果と確定事項）

### 問題なし（提示内容を採用）

- InnoDB 明示、UUID を `CHAR(36)` + アプリ生成、日時を `DATETIME` + UTC 運用の方針は一貫している
- `booth_tags` への正規化は MySQL の制約に沿った妥当な置き換え
- `check_ins.checkin_method` を `ENUM('qr','manual')` にしたのは、PostgreSQL 版の `CHECK (... IN (...))` と等価で読みやすい
- `booth_ratings.rating` の `CHECK (BETWEEN 1 AND 5)` は MySQL 8.0.16 以降で有効
- `survey_questions.options` / `user_survey_answers.custom_answers` / 推薦の JSON は、PostgreSQL の `JSONB` からの移行方針として妥当（検索・集計が重くなったら生成列や別テーブル化を検討）

### 設計書側で差し替えた点

- **`manual_code` の一意範囲:** 単独 `UNIQUE` だと全イベントでコードが衝突不能になる。運用上は **イベント内一意**が自然なため、`UNIQUE(event_id, manual_code)` に変更した

### 企画・UXで確定したこと（Canonical DDL に反映済み）

| 方針 | DB での表れ | 参加者・運営への効き |
|------|-------------|----------------------|
| 同一ブースへのチェックインは **1 人 1 回まで** | `UNIQUE KEY uq_checkin_user_booth (user_id, booth_id)` | 誤スキャン・通信リトライで来場数が水増ししにくい。KPI が説明しやすい |
| 評価は **チェックイン 1 回につき 1 件** | `UNIQUE KEY uq_rating_per_checkin (checkin_id)` | 「その場の来場」に紐づく評価で集計が直感的 |
| 同一ブースで **同じタグは 1 つ** | `UNIQUE KEY uq_booth_tag (booth_id, tag)` | フィルタ・一覧のノイズを減らす（`tag` は `VARCHAR(255)`） |
| ブースの **最終更新時刻を自動更新** | `updated_at ... ON UPDATE CURRENT_TIMESTAMP`（Docker は `+00:00`） | フォーム連携の反映確認に使いやすい |

### 任意（必要になったら追加）

| 論点 | メモ |
|------|------|
| `categories` に `created_at` 等 | 監査・サポート方針が固まったら |

---

## 14. 将来の過去データ参照への移行手順（メモ）

工数目安は約10〜15時間。

1. `users` テーブルから `event_id` を削除する
2. `event_participants` 中間テーブルを追加する（`user_id`, `event_id`）
3. `user_survey_answers` の紐づけを `event_participants` 経由に変更する
4. 認証ロジックを修正する（同一メールアドレスで複数イベントにまたがるセッション管理）
5. 既存 API の修正とテストを行う
