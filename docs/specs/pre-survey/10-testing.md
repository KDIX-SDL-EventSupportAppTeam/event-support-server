---
状態: 確定
最終更新: 2026-08-24
---

# 合格基準

## 実効開放状態の算出

- [ ] 3モード × 時刻境界（`app_opens_at` の1秒前 / 同時刻 / 1秒後）で正しく判定される
- [ ] `app_closes_at` あり／なしの両方で正しい
- [ ] `event_app_access` の行が無いイベントは `closed` 扱いになる
- [ ] レスポンスに `server_time` が含まれる

## 権限

- [ ] PUT: organizer 所有 → 200
- [ ] PUT: 非所有の organizer → 403
- [ ] PUT: `manager` の Bearer → 403
- [ ] PUT: 無認証 → 401
- [ ] admin の GET は `manager` / `viewer` で 200、書き込み系は無い

## バリデーション

- [ ] `mode='scheduled'` かつ `app_opens_at` なし → 400
- [ ] `app_closes_at < app_opens_at` → 400
- [ ] `mode` を `open` / `closed` にしても `app_opens_at` が保持される（null 化しない）

## 監査

- [ ] PUT で監査ログが1件増える
- [ ] `actor_role` に `organizer` が入る
- [ ] `detail` に変更前後の値が入る

## 公開エンドポイント

- [ ] 存在しない `event_id` → 404
- [ ] レスポンスに内部情報（`app_closes_at` / `updated_by`）が含まれない

## 回答送信

- [ ] 締切後 → 409（`PRE_SURVEY_CLOSED`）
- [ ] 必須設問の欠け → 400
- [ ] `options` に無い `value` → 400（**離散コードの整合性。分析の前提**）
- [ ] `answer_type` と値の型が一致しない → 400
- [ ] 2回送信しても行が増えず、UPDATE される
- [ ] `age_range` / `occupation` が専用列にも書かれる
- [ ] 関心分野が `custom_answers.interest_categories` に `category_id` の配列で入る

## 設問配信

- [ ] `interest_categories` の選択肢が `categories` から生成される
- [ ] カテゴリを追加すると、次の配信で選択肢に現れる
- [ ] カテゴリが0件でも 500 にならない
- [ ] 未ログインでも設問を取得できる

## ビンゴとの結合

- [ ] 回答済みの参加者のカードで、position 5 に関心分野と一致するブースが入る
- [ ] **未回答の参加者でもカードが正常に生成される**（position 5 は空・非表示）
- [ ] 関心分野に一致するブースが1つも無くてもカード生成が成功する
