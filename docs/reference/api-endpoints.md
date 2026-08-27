---
状態: 実装済み
最終更新: 2026-08-24
---

> **現状の事実を記録する文書。** 「これからどうするか」は [../specs/](../specs/README.md) を見ること。

# API エンドポイントと WebSocket イベント

| メソッド | パス | 認証 | 説明 |
|----------|------|------|------|
| GET | `/health` | — | 死活監視 |
| POST | `/api/v1/auth/register` | — | 参加者登録 |
| POST | `/api/v1/auth/register/admin` | `X-Admin-Key` | 運営アカウント登録 |
| POST | `/api/v1/auth/login` | — | ログイン・JWT 発行 |
| GET | `/api/v1/auth/verify-email` | — | メールアドレス確認（トークン照合・`users.email_verified_at` 更新） |
| POST | `/api/v1/auth/resend-verification` | Bearer | 確認メール再送 |
| GET | `/api/v1/events/:event_id/survey/questions` | Bearer | アンケート設問取得 |
| POST | `/api/v1/events/:event_id/survey/answers` | Bearer | アンケート回答送信 |
| GET | `/api/v1/events/:event_id/booths` | Bearer | ブース一覧（カテゴリフィルタ可） |
| GET | `/api/v1/events/:event_id/booths/:booth_id` | Bearer | ブース詳細 |
| POST | `/api/v1/events/:event_id/checkins` | Bearer | チェックイン（QR / 手動コード）。ビンゴの後出し割当・解放（`unlocked_positions` / `unlocked_pairs`）・ライン判定・`pending_rating` を含む |
| GET | `/api/v1/events/:event_id/checkins` | Bearer | 自分のチェックイン履歴 |
| POST | `/api/v1/events/:event_id/checkins/:checkin_id/rating` | Bearer | 評価送信（+comment、`context`。空白のみは NULL 正規化、再送信は 409。`rating` は `1..RATING_SCALE`） |
| GET | `/api/v1/events/:event_id/bingo/card` | Bearer | ビンゴカード取得（無ければ生成。解放漏れの self-healing を含む。`is_revealed=0` のマスは `booth` を `null` で返す） |
| PATCH | `/api/v1/events/:event_id/admin/booths/:booth_id/active` | Bearer（manager） | ブースの当日中止・復帰切り替え |
| POST | `/api/v1/events/:event_id/admin/bingo/reassign` | Bearer（manager） | 中止ブースが見えているマスに残っている場合の差し替え救済（`{booth_id}` → `{affected_cards, reassigned_cells, cleared_cells}`） |
| GET | `/api/v1/events/:event_id/app-access` | — | アプリ公開ゲートの実効状態（`is_open` / `mode` / `is_pre_survey_open` / `server_time`） |
| GET | `/api/v1/events/:event_id/pre-survey/questions` | — | 事前アンケート設問（`interest_categories` の選択肢は `categories` から動的生成） |
| GET / POST | `/api/v1/events/:event_id/gacha/coins` | Bearer | ガチャコイン（器のみ。換算規則は未確定） |
| GET / PUT | `/api/v1/organizer/events/:event_id/app-access` | Bearer（organizer、所有イベントのみ） | アプリ公開ゲートの参照・更新 |
| GET | `/api/v1/admin/events/:event_id/app-access` | Bearer（staff） | アプリ公開ゲートの参照（読み取り専用） |
| POST | `/api/v1/webhook/booths/sync` | `X-Api-Key` | ブース情報同期（Google Forms） |
| POST | `/api/v1/organizer/auth/register` | `X-Organizer-Key`（invite 時） | オーガナイザー登録 |
| POST | `/api/v1/organizer/auth/login` | — | オーガナイザーログイン・JWT 発行 |
| GET | `/api/v1/organizer/events` | Bearer（organizer） | 所有イベント一覧（統計・URL 付き、`date_start DESC`） |
| GET | `/api/v1/organizer/events/:event_id` | Bearer（organizer、所有イベントのみ） | イベント詳細（非所有・不存在は 403） |
| POST | `/api/v1/organizer/events` | Bearer（organizer） | イベント作成 + 初期管理者自動発行 + 参加者/運営 URL 発行 |
| GET | `/api/v1/organizer/events/:event_id/staff` | Bearer（organizer、所有イベントのみ） | 運営スタッフ一覧（招待順） |
| POST | `/api/v1/organizer/events/:event_id/staff` | Bearer（organizer、所有イベントのみ） | 運営スタッフ招待（manager/viewer） |
| PATCH | `/api/v1/organizer/events/:event_id/staff/:user_id` | Bearer（organizer、所有イベントのみ） | スタッフのロール変更（最後の manager ガード） |
| DELETE | `/api/v1/organizer/events/:event_id/staff/:user_id` | Bearer（organizer、所有イベントのみ） | スタッフ削除（最後の manager ガード） |
| DELETE | `/api/v1/organizer/events/:event_id/event-data` | Bearer（organizer、所有イベントのみ、確認文字列必須） | イベントデータ全削除（監査ログ記録） |
| GET | `/api/v1/events/:event_id/public` | — | 公開イベント情報（名前・日程・会場・アンケートURL） |
| POST | `/api/v1/admin/events/:event_id/exhibitors/bulk` | Bearer（manager） | 出展者アカウント一括登録（行単位の成功/失敗を返す） |
| GET | `/api/v1/events/:event_id/exhibitor/booths` | Bearer | 出展者の担当ブース一覧（exhibitor 以外は空で返す） |
| GET | `/api/v1/events/:event_id/exhibitor/booths/:booth_id/stats` | Bearer（担当ブースのみ、DB 認可） | 出展者向け集計（チェックイン数・時間帯別・評価分布・コメント） |
| GET | `/api/v1/events/:event_id/exhibitor/booths/:booth_id/comments` | Bearer（担当ブースのみ、DB 認可） | 出展者向けコメント一覧（limit/offset。匿名・is_hidden 除外） |
| GET / PATCH | `/api/v1/admin/events/:event_id` | Bearer（manager。GET は viewer も可） | イベント情報取得・更新 |
| GET | `/api/v1/admin/events/:event_id/audit-logs` | Bearer（staff = manager+viewer） | 監査ログ一覧（ページネーション付き） |
| GET | `/api/v1/admin/events/:event_id/booths/:booth_id/comments` | Bearer（staff = manager+viewer） | 運営向けコメント一覧（limit/offset。`is_hidden`・表示名を含む） |
| GET | `/api/v1/admin/events/:event_id/booths` | Bearer（staff = manager+viewer） | 運営向けブース一覧（`sort=checkin_count\|avg_rating\|name`・`order=asc\|desc`、既定 `checkin_count desc`。不正値は既定値にフォールバック） |
| POST / DELETE | `/api/v1/admin/events/:event_id/sample-data` | Bearer（manager） | サンプルデータ生成・削除 |
| GET | `/api/v1/admin/events/:event_id/dashboard` | Bearer（staff） | 運営ダッシュボード（簡易集計） |
| GET | `/api/v1/admin/events/:event_id/analytics/{booths,participants,checkins,recommendations}` | Bearer（staff） | 分析データ取得（推薦集計の集計元は下記） |
| CRUD | `/api/v1/admin/events/:event_id/{categories,booths,survey-questions}` ほか | Bearer（manager。GET 系は staff） | カテゴリ/ブース/設問の運営 CRUD・参加者一覧 |

運営 CRUD の各エンドポイントは `src/routes/v1/admin/` 配下に分割、オーガナイザー系は `src/routes/v1/organizer/` 配下（`app.ts` の登録順を参照）。

#### `analytics/{booths,recommendations}` の推薦集計（マイグレーション09以降）

`recommendations` テーブルは廃止され、集計元は `recommendation_scores`（候補ブース1件 = 1行）に移行した
（テーブルの役割は [database.md](database.md#ビンゴカード動的段階解放方式)）。
`recommendation_scores` に `event_id` 列は無いため `card_unlock_events` → `bingo_cards` を JOIN してイベントを絞る。
**`users.event_id` では絞らない**（出展者・運営アカウントが混ざるため）。

応答フィールドの名前・型・null 許容は従来のまま（フロント無改修）。ただし **`selected` 系の意味が変わった**:

| フィールド | 旧: `recommendations` | 新: `recommendation_scores` |
|---|---|---|
| `recommendation_offered_count` / `by_booth.offered_count` / `summary.total_recommendations` | 提示回数 | 候補として記録された行数（`COUNT(*)`） |
| `recommendation_selected_count` / `by_booth.selected_count` / `summary.selected_count` | 利用者が提示から**選んだ**件数 | システムがマスに**割り当てた**件数（`SUM(was_assigned)`） |
| `summary.algorithm` | `recommendations.algorithm` | `card_unlock_events.strategy` の最頻値（行が無ければ `mab`） |
| `conversion.*` | 選択ブース→チェックインの導線 | 割り当てブース→チェックインの導線（推薦時刻は `recommendation_scores.created_at`） |

サンプルデータ生成（`sample-data/generate`）は `recommendation_scores` を作らない（解放処理の副産物のため）。
サンプル投入時、推薦分析は 0 件表示になるがエラーにはならない。詳細は
[docs/specs/migration-09-followup/README.md](../specs/migration-09-followup/README.md) §4-B。

### WebSocket（socket.io）

- 接続時に JWT（`auth.token`）で認証し、`event:<event_id>`（全員）/ `event:<event_id>:admin`（`manager` または `viewer` のみ）ルームへ参加
- ユーザー個別ルーム `event:<event_id>:user:<user_id>` にも自動参加する（ビンゴ解放通知の配信先）
- サーバー → クライアントのイベント:
  - `checkin:new` — チェックイン発生時に運営ルームへ配信
  - `rating:new` — 評価送信時に運営ルームへ配信
  - `bingo:unlocked` — 中央4マス完成による解放時にユーザー個別ルームへ配信（`{ card_id, unlocked_at }`。正の経路はチェックインレスポンスの `unlocked: true`、socket は取りこぼし対策の副経路）
- 配信が複数インスタンスで届かない問題を避けるため Cloud Run は 1 インスタンス固定（[ADR 0002](../decisions/adrs/0002-cloud-run-single-instance-for-websocket.md)）

> 一意制約（チェックイン/評価/メール）は、さくらプロキシがエラーを 500 に潰す都合上 INSERT 前に SELECT で重複確認する（[ADR 0001](../decisions/adrs/0001-sakura-proxy-error-masking.md)）。
> 詳細は （旧設計は archive にあるが参照しない）
