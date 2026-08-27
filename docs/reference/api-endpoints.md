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
| POST | `/api/v1/events/:event_id/checkins` | Bearer | チェックイン（QR / 手動コード）。ビンゴの後出し割当・解放・ライン判定・`pending_rating` を含む |
| GET | `/api/v1/events/:event_id/checkins` | Bearer | 自分のチェックイン履歴 |
| POST | `/api/v1/events/:event_id/checkins/:checkin_id/rating` | Bearer | 評価送信（+comment、`context`。空白のみは NULL 正規化、再送信は 409。`rating` は `1..RATING_SCALE`） |
| GET | `/api/v1/events/:event_id/bingo/card` | Bearer | ビンゴカード取得（無ければ生成。`status='UNLOCKED'` の self-healing を含む） |
| GET | `/api/v1/events/:event_id/gacha/coins` | Bearer | ガチャコイン枚数（`is_enabled / lines_completed / earned / used / available / max_coins`）。無効時も 200 |
| POST | `/api/v1/events/:event_id/gacha/coins/use` | Bearer | コイン1枚消費（`idempotency_key` はクライアント生成 UUID 必須）。再送は同じ行を返し枚数は増えない。`403 GACHA_DISABLED` / `409 NO_COINS_AVAILABLE` |
| GET | `/api/v1/admin/events/:event_id/gacha/stats` | Bearer（manager/viewer） | ガチャ使用状況（`total_used / users_with_coins / users_who_used / used_by_hour`） |
| PATCH | `/api/v1/events/:event_id/admin/booths/:booth_id/active` | Bearer（manager） | ブースの当日中止・復帰切り替え |
| POST | `/api/v1/events/:event_id/admin/bingo/reassign` | Bearer（manager） | 中止ブースが割当済みマスに残っている場合の差し替え救済 |
| GET | `/api/v1/events/:event_id/recommendations` | Bearer | 推薦取得（`RECOMMENDER_URL` 設定時は外部推薦、未設定/失敗時はランダム） |
| POST | `/api/v1/events/:event_id/recommendations/:recommendation_id/select` | Bearer | 推薦選択 |
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
| GET | `/api/v1/organizer/events/:event_id/gacha/settings` | Bearer（organizer、所有イベントのみ） | ガチャ換算規則の取得（行が無ければ既定値 `0/1/4/0`） |
| PUT | `/api/v1/organizer/events/:event_id/gacha/settings` | Bearer（organizer、所有イベントのみ） | ガチャ換算規則の更新（`is_enabled` で当日停止。`coins_per_line` 0-10 / `max_coins` 0-50 / `bonus_coins` 0-10。監査ログ記録） |
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
| GET | `/api/v1/admin/events/:event_id/analytics/{booths,participants,checkins,recommendations}` | Bearer（staff） | 分析データ取得 |
| CRUD | `/api/v1/admin/events/:event_id/{categories,booths,survey-questions}` ほか | Bearer（manager。GET 系は staff） | カテゴリ/ブース/設問の運営 CRUD・参加者一覧 |

運営 CRUD の各エンドポイントは `src/routes/v1/admin/` 配下に分割、オーガナイザー系は `src/routes/v1/organizer/` 配下（`app.ts` の登録順を参照）。

### WebSocket（socket.io）

- 接続時に JWT（`auth.token`）で認証し、`event:<event_id>`（全員）/ `event:<event_id>:admin`（`manager` または `viewer` のみ）ルームへ参加
- ユーザー個別ルーム `event:<event_id>:user:<user_id>` にも自動参加する（ビンゴ解放通知の配信先）
- サーバー → クライアントのイベント:
  - `checkin:new` — チェックイン発生時に運営ルームへ配信
  - `rating:new` — 評価送信時に運営ルームへ配信
  - `bingo:unlocked` — 中央4マス完成による解放時にユーザー個別ルームへ配信（`{ card_id, unlocked_at }`。正の経路はチェックインレスポンスの `unlocked: true`、socket は取りこぼし対策の副経路）
- 配信が複数インスタンスで届かない問題を避けるため Cloud Run は 1 インスタンス固定（[ADR 0002](../decisions/adrs/0002-cloud-run-single-instance-for-websocket.md)）

> 一意制約（チェックイン/評価/メール）は、さくらプロキシがエラーを 500 に潰す都合上 INSERT 前に SELECT で重複確認する（[ADR 0001](../decisions/adrs/0001-sakura-proxy-error-masking.md)）。
> 詳細は [docs/archive/legacy/designs/api.md](../archive/legacy/designs/api.md) を参照。
