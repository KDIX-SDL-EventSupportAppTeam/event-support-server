---
状態: 草案
最終更新: 2026-09-10
---

# 未決定事項

## PQ-1 性別の設問を追加するか ── 決定済み（2026-09-10）

**追加する。ただし任意回答（`is_required = false`）で、層別軸としてのみ使う。**

`question_key = 'gender'`、`value` は `male` / `female` / `other` / `prefer_not_to_say`。
本番の設問セットの5問目として `db/migrations/16_pre_survey_questions.sql` で投入する。

- 締切後には取れないため、1タップのコストで取っておく
- **条件属性にも SIMILARITY の近傍計算にも使わない。** 去年「その他」が3名で、
  軸にすると個人を指しうるため
- `prefer_not_to_say` を選択肢に置き、必須にしない

## PQ-2 回答済み判定 API の形 ── 決定済み（2026-08-28）

**案 B を採用。** `GET /events/:event_id/me/state` を新設し、
`email_verified` / `survey_answered` / `survey_answered_at` / `app_access` をまとめて返す。

配布リンクを単一 URL にする方針（参加者は常に同じ URL を踏み、状態で表示が変わる）のため、
分岐に必要な材料を 1 リクエストで揃える必要がある。案 A（回答有無だけの専用エンドポイント）だと
メール確認状態と公開ゲートを別々に取りに行くことになり、往復が増えるうえ判定がクライアント側に散る。

契約は [06-api.md](./06-api.md) を正本とする。

## PQ-3 設問数を減らせるか ── 決定済み（2026-09-10）

**必須5問 + 任意1問の6問に確定した。** 旧8問案から4問を落とし、2問を足した。

落としたもの: `attend_count` / `purpose` / `motivation` / `knowledge_level` / `free_comment`。
いずれもブース側に掛け合わせる相手が無く、順位づけに寄与しない
（`knowledge_level` はブース側が D-12 で不採用）。

足したもの: `top_interest_category`（主属性の解像度が2段階→3段階になる）と
`exploration_disposition`（セレンディピティの調整変数。後から取れない）。

**アルゴリズムが実際に使うのは `interest_categories` と `top_interest_category` の2問だけ**で、
残りは1タップの層別変数という構成。一覧は [02-data-model.md](02-data-model.md)。

## PQ-4 タイムゾーンの扱い

`pre_survey_closes_at` の「前日 23:59:59」は JST 基準で計算するが、
保存は UTC。境界のテストを必ず書く。

## PQ-5 自動閉鎖（`app_closes_at`）を使うか

イベント終了後に自動で閉じる用途。列は用意するが、今年使うかは未定。
未設定なら閉じない。
