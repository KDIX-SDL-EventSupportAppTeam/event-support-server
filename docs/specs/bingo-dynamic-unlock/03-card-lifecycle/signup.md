---
状態: 実装済み
最終更新: 2026-08-25
---

# カード発行と事前推薦マス

## トリガー

**サインアップ時、または参加者が初めてカードを要求した時のいずれか早い方。**
「無ければ作る」方式にする。理由:

- 既存ユーザー（テスト参加者）にもカードが行き渡る
- サインアップ経路が複数ある（メール / Google）ため、発行処理を1か所に集約できる
- 事前アンケート未回答でも**カードは必ず正常に生成されなければならない**

`src/lib/bingo/ensureCard.ts` に切り出し、カード取得 API とチェックイン API の両方から呼ぶ。

## 手順

1. `bingo_cards` に1行 INSERT
   - **INSERT 前に `SELECT ... WHERE event_id=? AND user_id=?` で存在確認する**
     （プロキシは重複キーを 500 に潰す。[ADR 0001](../../../decisions/adrs/0001-sakura-proxy-error-masking.md)）
   - 競合で2行目の INSERT が失敗した場合は、**エラーにせず既存カードを読み直して返す**
2. `bingo_cells` を **16行**まとめて INSERT
   - position 5, 6, 9, 10 → `zone='CENTER'`, `is_revealed=0`, `is_achieved=0`, `booth_id=NULL`
   - それ以外の12個 → `zone='OUTER'`, `is_revealed=0`, `is_achieved=0`, `booth_id=NULL`
3. **position 5 を事前推薦マスにする**
   - `booth_id = pickPreSurveyBooth()` の結果
   - `is_revealed=1`, `is_achieved=0`, `source='PRESURVEY'`, `assigned_at=now`
   - 推薦ブースが決まらなかった場合（アンケート未回答・候補なし）は
     **`booth_id=NULL`, `is_revealed=0`, `source=NULL` のままにする**
4. 残る中央3マスは何も決めない

**この時点で外周12マスは何も決まっていない。推薦計算は走らない。ここが本設計の要点である。**

## 事前推薦ブースの決定

```ts
// src/lib/bingo/pickPreSurveyBooth.ts
export async function pickPreSurveyBooth(
  db: DbClient,
  eventId: string,
  userId: string,
): Promise<string | null>
```

**この関数は例外を投げてはならない。** 決まらなければ `null` を返す。

### 規則

1. `user_survey_answers` からその参加者の**関心分野**を読む
   （`categories` と同じ器。[D-13](../01-concept/decisions.md)）
2. 関心分野に一致するカテゴリのブースのうち、`is_active = 1` のものを候補にする
3. 候補の中から、**そのイベントでの訪問者数が少ない順**に並べ、上位30%からランダムに1件選ぶ
4. 候補が0件（未回答・該当ブースなし）なら **`null` を返す**

**「ベタな推薦」でよい**（打ち合わせでの表現）。DRSA は通さない。
イベント開始直後は行動データが存在せず、通す意味がないためである。

### 訪問者数が少ない順にする理由

人気ブースを配ると[成功の定義](../README.md#絶対に破ってはいけない制約)と逆行する。
去年のフォールバックがブース人気度ランキングに退化していた失敗を繰り返さない。

### 記録

事前推薦も推薦の一種なので、`recommendation_scores` に記録する。
このとき `unlock_event_id` は解放イベントに紐づかないため、
**`card_unlock_events` に `pair_key='PRESURVEY'`, `line_index=-1`, `released_positions='5'`,
`phase='PRESURVEY'` の行を1つ作り、そこへ紐づける。**

**除外されていない候補ブースを全件記録する**（D-10）。解放時と同じく、
推薦されなかった候補も分母に入れないと研究の対照が取れない。
`was_assigned = 1` は実際にカードへ載った1件のみ。冪等性は
`card_unlock_events` の `UNIQUE (card_id, pair_key)` で担保する
（この行の INSERT が `affectedRows = 1` を返したときだけ `recommendation_scores` を書く）。

- **`score` / `rank_in_event` は NULL にする。** この2列は「推薦エンジンが付けた値」を
  入れる場所であり、事前推薦は推薦エンジンを通していない（訪問者数の少ない順に選ぶだけ）。
  選定順の連番を入れると、分析側がエンジンの順位と区別できなくなる。
  解放時も、推薦エンジンが返さなかった候補は NULL で記録している。
- **書き込みは1回の複数行 INSERT にまとめる。** 本番 DB は 1リクエスト = 1SQL のため、
  候補1件ごとに INSERT すると候補数ぶんの往復になる。カードの初回発行は
  開場直後に全員が同時に通る経路なので、ここを N 往復にしてはならない
  （解放側 `assignOuterCells.ts` の C-2 と同じ方針）。

これにより「事前推薦マスへの訪問率」も他の推薦と同じ方法で分析できる。

## 冪等性

同一ユーザーに対する `ensureCard` の同時実行で、カードが2枚できたり
マスが16行を超えたりしてはならない。

- `bingo_cards` の `UNIQUE (event_id, user_id)`
- `bingo_cells` の `UNIQUE (card_id, position)`

重複は `INSERT ... ON DUPLICATE KEY UPDATE` で**そもそも例外にせず**、
INSERT のあとに必ず SELECT で読み直して返す。

`catch (err.code === 'ER_DUP_ENTRY')` に頼ってはならない。さくらプロキシは
重複キーを code の無い 500 に潰すため、例外で分岐する実装は本番経路でだけ
500 に化ける（[ADR 0001](../../../decisions/adrs/0001-sakura-proxy-error-masking.md)）。

競合に負けた側は、`position 5` に載っているのが相手の選んだブースになる。
`recommendation_scores` の `was_assigned = 1` は自分の候補ではなく
**実際にカードへ載ったブース**に付ける（そのブースが自分の候補全件に含まれていなければ足す）。

## 検証（テストで固定する）

カード生成直後に以下が成り立つこと。

- `bingo_cells` が正確に16行、`position` は 0..15 が1つずつ
- `zone='CENTER'` が4行で `position` は {5, 6, 9, 10}
- `is_achieved = 1` の行が **0行**（参加ボーナスは廃止。[D-1](../01-concept/decisions.md)）
- アンケート回答済みの場合: `is_revealed = 1` の行がちょうど1行で position 5、
  `source='PRESURVEY'`、`booth_id` が NOT NULL
- アンケート未回答の場合: `is_revealed = 1` の行が **0行**、それでもカード生成は成功する
- `card_unlock_events` は 0 行または `pair_key='PRESURVEY'` の1行のみ
- アンケート回答済みの場合: `pair_key='PRESURVEY'` の unlock_event に
  候補ブース数ぶんの `recommendation_scores` 行があり、`was_assigned = 1` は1行だけ
- カード発行が二重に走っても `recommendation_scores` の行が重複しない
