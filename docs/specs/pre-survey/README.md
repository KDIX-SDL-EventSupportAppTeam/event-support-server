---
状態: 草案
最終更新: 2026-08-24
---

# 事前アンケートとアプリ公開ゲート

参加者がイベント前日までに回答する事前アンケートと、
アプリ本体を開催直前まで開けないようにするゲートの仕様。

## なぜこれが最優先なのか

**ビンゴ動的段階解放の前提である。**
[事前推薦マス](../bingo-dynamic-unlock/03-card-lifecycle/signup.md)（position 5）は、
参加者が来場した瞬間に「あなたにはこのブースがおすすめです」と表示する。
その材料は事前アンケートの回答**だけ**である（まだ1件も訪問していないため）。

回答が DB に入っていなければ、事前推薦マスは常に空になる。

さらに、回答はラフ集合分析の条件属性としても使う
（[phases.md](../bingo-dynamic-unlock/05-recommender/phases.md) の SIMILARITY フェーズ）。

## 現状

| 要素 | 状態 |
|---|---|
| フロント5画面（Entry / SignUp / SignIn / Form / Thanks） | **モック実装済み**（localStorage ベース。`feat/pre-survey-and-app-access-gate` ブランチ） |
| 設問定義 | フロントにハードコード（8問） |
| サーバー実装 | **未着手** |
| `survey_questions` / `user_survey_answers` テーブル | 既存。そのまま使う |
| `event_app_access` テーブル | 未作成 |

**新しく作る話ではなく、設計済みのものを実装する。**
元の作業指示は
[archive/orders/2026-08-17-依頼-事前アンケートとアプリ公開ゲート.md](../../archive/orders/2026-08-17-依頼-事前アンケートとアプリ公開ゲート.md)
（フロント側リポジトリに全文がある）。本ディレクトリがそれを引き継いだ正本である。

## 読む順序

| # | ファイル | 内容 |
|---|---|---|
| 01 | [concept.md](01-concept.md) | 背景・設計判断 |
| 02 | [data-model.md](02-data-model.md) | テーブルと既存テーブルの使い方 |
| 06 | [api.md](06-api.md) | エンドポイント定義 |
| 09 | [open-questions.md](09-open-questions.md) | 未決定 |
| 10 | [testing.md](10-testing.md) | 合格基準 |

## 全体の流れ

```
[前日まで]  配布URL /pre-survey/:eventId
              ├ 初回      → /signup  参加者アカウント作成 → /form 回答 → /thanks
              └ 2回目以降 → /signin
                              ├ 回答済み → /thanks
                              └ 未回答   → /form → /thanks

/thanks（回答ありがとうございました）
   └ [アプリに移動する]
        ├ is_open === true   → 有効。押すと /home へ
        └ is_open === false  → 無効 + 「開放予定 10/16 09:30（あと 3 時間 12 分）」

[開催直前]  主催者が app_access を open にする、または app_opens_at 到達
              → /thanks を開いている参加者のボタンが自動で有効化される（ポーリング）
```

## 絶対に破ってはいけない制約

1. **実効開放状態はサーバーが算出する。** クライアントの時計を信用しない
2. **ゲートの書き込みは `organizer` のみ。** `manager` / `viewer` は読み取り専用
3. **回答は既存の `survey_questions` / `user_survey_answers` に保存する。** 新テーブルを作らない
4. **1参加者1回答。** 重複 INSERT せず、既存行があれば UPDATE する
5. **回答が無くてもビンゴカードは正常に生成される**
   （[edge-cases E1](../bingo-dynamic-unlock/08-edge-cases/edge-cases.md)）
