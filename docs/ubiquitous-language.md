# ユビキタス言語定義（サーバー）

このリポジトリで使用する用語の定義。  
**コード・ドキュメント・会話すべてでこの語彙を統一して使う。**

新しい用語を導入する／既存の語を変更する場合は本ファイルを更新し、関連する AI ドキュメント・ADR を見直すこと。

---

## アクター

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| 参加者 | `user` / `participant` | イベントに参加しブースを回る人。`users` テーブルで管理 |
| 出展者 | `exhibitor` | ブースを出す人。Google フォームでブース情報を登録する |
| 運営 | `manager` / `viewer` | イベント単位でイベントを管理する人の総称。運営管理者（`manager`）と運営閲覧者（`viewer`）からなる。旧 `admin` は `manager` に移行済み（`03_organizer_self_management.sql` の UPDATE 文） |
| 運営管理者 / Manager | `manager` | イベント単位の運営ロール。ブース等の作成・編集・削除が可能 |
| 運営閲覧者 / Viewer | `viewer` | イベント単位の運営ロール。閲覧のみ可能 |
| 主催者 / Organizer | `organizer` | イベントを横断して作成・編集できるプラットフォームレベルのアカウント。`event_id` を持たない。`organizers` テーブルで管理 |
| 主催者ポータル / Organizer Portal | — | 主催者がイベントを管理する画面群 |

---

## イベント

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| イベント | `event` | アプリが対象とする展示会・カンファレンス等の全体。`events` テーブルで管理 |
| イベントID | `event_id` | イベントを一意に識別する UUID。JWT に含まれ、全エンドポイントの認可に使う |

---

## ブース

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| ブース | `booth` | 出展者が設置する展示スペース。`booths` テーブルで管理 |
| ブースID | `booth_id` | ブースを一意に識別する UUID |
| 手動コード | `manual_code` | QR が使えない場合の代替入力コード。`booths.manual_code`（最大 6 文字・大文字で照合） |
| カテゴリ | `category` | 運営が定義するブースの分類。`categories` テーブルで管理。`booths.category_id` で参照 |
| タグ | `tag` | ブースに付与するフリーワードの属性。`booth_tags` テーブルで管理（多対多） |
| ブース特性ラベル | `label` | チェックイン数・滞在時間・訪問者属性から算出する動的バッジ。現状は空配列（将来実装） |
| チェックイン数（直近10分） | `checkin_count_last_10min` | `DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)` 以降のチェックイン数 |
| チェックイン数（直近30分） | `checkin_count_last_30min` | `DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)` 以降のチェックイン数 |
| 平均滞在時間 | `avg_stay_minutes` | 次チェックインまでの時間差で近似。現状は `null`（将来実装） |
| 平均評価 | `avg_rating` | そのブースの評価の平均値。`booth_ratings` から集計 |

---

## チェックイン

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| チェックイン | `check_in` | 参加者がブースを訪問したことを記録する行為。`check_ins` テーブルで管理 |
| チェックインID | `checkin_id` | チェックインレコードを一意に識別する UUID |
| チェックイン方法 | `checkin_method` | `qr`（ブース ID を直接指定）または `manual`（手動コードで検索） |
| チェックイン日時 | `checked_in_at` | クライアントが記録した訪問日時。ISO8601 で受け取り MySQL UTC に変換して保存 |
| 同期日時 | `synced_at` | サーバーがレコードを受け取った日時。`UTC_TIMESTAMP()` で記録 |
| 二重チェックイン | — | 同一 `user_id` × `booth_id` の重複 INSERT。`ER_DUP_ENTRY` を `CONFLICT` エラーで返す |

---

## 評価

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| 評価 | `rating` | チェックイン後に参加者がブースにつける 1〜5 の整数。`booth_ratings` テーブルで管理 |
| 評価ID | `rating_id` | 評価レコードを一意に識別する UUID |
| スキップ | — | 評価エンドポイントを叩かないこと。レコードは作成されない |

---

## 推薦

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| 推薦 | `recommendation` | チェックイン後にシステムが生成するブース候補 3 択。`recommendations` テーブルで管理 |
| 推薦ID | `recommendation_id` | 推薦レコードを一意に識別する UUID |
| 提示ブース | `offered_booth_ids` | 参加者に提示した 3 つのブース UUID の配列。JSON カラムで保存 |
| 選択ブース | `selected_booth_id` | 参加者が選んだブースの UUID。未選択は `NULL` |
| 却下ブース | `rejected_booth_ids` | 参加者が選ばなかったブースの UUID 配列。JSON カラムで保存 |
| 推薦枠 | `recommend` | パーソナライズ推薦。`reason` フィールドの値 |
| 準推薦枠 | `semi_recommend` | やや外れるが関連性がある推薦。`reason` フィールドの値 |
| ディスカバリー枠 | `discovery` | 意外な出会いを促すブース。`reason` フィールドの値。固定で 1 枠確保 |
| アルゴリズム | `algorithm` | 推薦の計算方式。`recommendations.algorithm` カラムに記録 |
| フェーズ | `phase` | 推薦エンジンがチェックインデータ量を見て自律判定する段階（0〜3） |

### 推薦フェーズ

| フェーズ | 条件 | アルゴリズム |
|--------|------|--------------|
| フェーズ0 | デフォルト | ランダム（現状の実装） |
| フェーズ1 | データが少ない | コンテンツベースフィルタリング |
| フェーズ2 | データが蓄積 | ラフ集合 + MAB |
| フェーズ3 | データが豊富 | MAB 本格稼働 + セッションベース推薦 |

---

## 認証・ユーザー

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| ユーザー | `user` | 参加者のアカウント。`users` テーブルで管理。イベントごとに独立（同メールでも別イベントなら別レコード） |
| ユーザーID | `user_id` | ユーザーを一意に識別する UUID。JWT の `sub` フィールドに入る |
| 表示名 | `display_name` | アプリ内で表示される名前。`users.display_name` |
| メールアドレス | `email` | ログインキー。`event_id` × `email` で一意制約 |
| パスワードハッシュ | `password_hash` | bcrypt（コスト 10）でハッシュ化したパスワード。`users.password_hash` |
| JWT トークン | `token` | ログイン・登録時に発行するアクセストークン |
| JWT ペイロード（参加者/運営） | — | `{ sub: user_id, event_id, display_name, role }`。イベント終了 +24h 有効 |
| JWT ペイロード（主催者） | — | `{ sub: organizer_id, scope: 'organizer' }`。`event_id` を持たない。30 日有効 |
| ロール | `role` | JWT に含まれる権限種別。`participant`（参加者）/ `manager`（運営管理者）/ `viewer`（運営閲覧者）。旧 `admin` は `manager` の後方互換値 |
| Bearer 認証 | — | `Authorization: Bearer <token>` ヘッダーによる認証方式 |
| `requireBearerAuth` | — | JWT の署名・有効期限を検証する preHandler |
| `requireEventMatchesJwt` | — | URL の `:event_id` と JWT の `event_id` の一致を検証する preHandler |
| `requireManager` | — | `role: manager`（または旧 `admin`）を要求する preHandler |
| `requireStaff` | — | `role: manager` または `viewer`（= 運営）を要求する preHandler |
| `requireOrganizer` | — | 主催者 JWT（`scope: 'organizer'`）を検証する preHandler |
| `requireAdmin` | — | `requireManager` の後方互換エイリアス |
| メール確認 | `email_verified` / `email_verified_at` | 参加者が登録メール内の確認URLを踏んで本人確認を完了したこと。`users.email_verified_at`（DATETIME NULL）が非NULLになる |
| 確認トークン | `email_verification_tokens` | メール確認用の一時トークン（64桁hex・有効期限24h）。`email_verification_tokens` テーブルで管理。有効なトークンは常に最大1個（発行時に既存を削除） |
| `requireVerifiedEmail` | — | `role: participant` かつ `email_verified_at IS NULL` の場合に 403 `EMAIL_NOT_VERIFIED` を返す preHandler。manager/viewer 等は対象外 |

---

## オーガナイザー管理

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| 初期管理者自動発行 | — | イベント作成時に、そのイベント用の `role='manager'` ユーザーを同時に作成すること |
| スタッフ招待 | — | 主催者がイベントに運営スタッフ（manager/viewer）を email・ロール指定で追加すること |
| スタッフ管理 | — | 主催者がイベントのスタッフを一覧・ロール変更・削除すること（招待は「スタッフ招待」）。監査 action は `staff.role_change` / `staff.remove` |
| 開催ステータス | — | イベントの時間的状態（準備中 / 開催中 / 終了）。`date_start`/`date_end` と現在時刻から導出する。DB には保存せずフロントエンドで算出する |
| 監査ログ / Audit Log | `audit_logs` | 誰が・いつ・何をしたかの操作証跡。`actor_role` に `manager` / `viewer` / `organizer` が入る。action は `booth.*` / `category.*` / `survey_question.*` / `staff.invite` / `staff.role_change` / `staff.remove` |
| 参加者 URL / 運営 URL | — | イベント作成時に発行される、参加者登録画面・運営ログイン画面への入口リンク。`FRONTEND_BASE_URL` から生成 |

---

## アンケート

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| アンケート | `survey` | 初回ログイン後に参加者が回答する設問群 |
| 固定設問 | `fixed_questions` | 全イベント共通。コードで定義（年齢層・職業・業種）。`survey_questions` テーブルには入らない |
| カスタム設問 | `custom_questions` | 運営がイベントごとに設定。`survey_questions` テーブルで管理 |
| アンケート回答 | `survey_answer` | `user_survey_answers` テーブルで管理。固定設問はカラム、カスタムは JSON カラムに保存 |
| 年齢層 | `age_range` | `user_survey_answers.age_range` |
| 職業 | `occupation` | `user_survey_answers.occupation` |
| 業種 | `industry` | `user_survey_answers.industry` |
| カスタム回答 | `custom_answers` | `user_survey_answers.custom_answers`（JSON） |

---

## 運営・ダッシュボード

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| ダッシュボード | `dashboard` | 運営向けのリアルタイム集計 API |
| チェックイン総数 | `total_checkins` | イベント全体の `check_ins` 件数 |
| 参加者数 | `total_participants` | イベントの `users` 件数 |
| 平均チェックイン数 | `avg_checkins_per_user` | `total_checkins / total_participants` |
| 属性別分布 | `visitor_breakdown` | ブースの訪問者を年齢層・職業等で集計したデータ |
| チェックインタイムライン | `checkin_timeline` | 時間帯ごとのチェックイン件数の推移 |

---

## リアルタイム通信

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| WebSocket | — | socket.io による双方向通信。Issue #8 で実装 |
| イベントルーム | `event:<event_id>` | socket.io のルーム名。イベント ID を単位として参加者をグループ化 |
| 推薦更新イベント | `recommendation:updated` | チェックイン後に推薦が生成されたことを参加者に通知する socket イベント |
| ダッシュボード更新イベント | `dashboard:stats:updated` | チェックインのたびに集計が更新されたことを運営に通知する socket イベント |
| セッションアフィニティ | `--session-affinity` | Cloud Run デプロイ時に必要なフラグ。socket.io の接続を同一インスタンスに固定する |

---

## 外部連携

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| Webhook | `webhook` | Google Apps Script がブース情報の更新を検知してサーバーに送る HTTP リクエスト |
| Webhook キー | `WEBHOOK_API_KEY` | `X-Api-Key` ヘッダーで送られる認証キー。環境変数で管理 |
| ブース同期 | `booth sync` | Webhook 受信時にブース情報を `booths` テーブルに INSERT または UPDATE する処理 |
| エクスポート | `export` | イベント終了時に集計データを Google Sheets に出力する機能 |

---

## DB テーブル一覧

| テーブル名 | 対応するドメイン概念 |
|------------|----------------------|
| `events` | イベント |
| `users` | ユーザー（参加者） |
| `categories` | カテゴリ |
| `booths` | ブース |
| `booth_tags` | タグ（多対多） |
| `survey_questions` | カスタム設問 |
| `user_survey_answers` | アンケート回答 |
| `check_ins` | チェックイン |
| `booth_ratings` | 評価 |
| `recommendations` | 推薦 |
| `booth_categories` | ブースとカテゴリの多対多 |
| `organizers` | 主催者 |
| `audit_logs` | 監査ログ |

---

## API 規約

| 日本語 | コード上の名前 | 定義 |
|--------|----------------|------|
| 成功レスポンス | `{ success: true, data: {...} }` | `sendOk(reply, data)` で生成 |
| 失敗レスポンス | `{ success: false, error: { code, message } }` | `sendFail(reply, status, code, message)` で生成 |
| 未認証 | `UNAUTHORIZED` | トークンがない・無効・期限切れの場合 |
| 未発見 | `NOT_FOUND` | 指定リソースが存在しない場合 |
| 競合 | `CONFLICT` | 二重チェックイン・重複登録（`ER_DUP_ENTRY`）の場合 |
| バリデーションエラー | `VALIDATION_ERROR` | zod パース失敗など入力値が不正な場合 |
| サーバーエラー | `INTERNAL_ERROR` | 予期しない例外が発生した場合 |
| トークン無効 | `TOKEN_INVALID` | メール確認トークンが存在しない・使用済みの場合（`GET /auth/verify-email`） |
| トークン期限切れ | `TOKEN_EXPIRED` | メール確認トークンの有効期限が切れている場合（`GET /auth/verify-email`） |
| メール未確認 | `EMAIL_NOT_VERIFIED` | 未確認の participant がチェックイン等の制限対象操作を行った場合 |
| 確認済み | `ALREADY_VERIFIED` | 確認済みユーザーが確認メール再送を要求した場合（`POST /auth/resend-verification`） |
