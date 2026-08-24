# カード発行と参加ボーナス

## トリガー

**サインアップ時、または参加者が初めてカードを要求した時のいずれか早い方。**
「無ければ作る（get-or-create）」方式にする。理由:

- 既存ユーザー（テスト参加者）にも自然にカードが行き渡る
- サインアップ経路が複数ある（メール / Google）ため、発行処理を1か所に集約できる
- 事前アンケート未回答でも**カードは必ず正常に生成されなければならない**（E6）

実装は `src/lib/bingo/ensureCard.ts` 相当に切り出し、`GET /events/:event_id/bingo/card` と `POST /events/:event_id/checkins` の両方から呼べるようにする。

## 手順

1. `bingo_cards` に `status='CENTER_ONLY'` で1行 INSERT
   - **INSERT 前に `SELECT ... WHERE event_id=? AND user_id=?` で存在確認する**（プロキシは重複キーを 500 に潰す。[ADR 0001](../../adrs/0001-sakura-proxy-error-masking.md)）
   - 競合で 2 行目の INSERT が失敗した場合は、**エラーにせず既存カードを読み直して返す**
2. `bingo_cells` を **16行**まとめて INSERT
   - `position` 5, 6, 9, 10 → `zone='CENTER'`, `state='EMPTY'`, `booth_id=NULL`, `source=NULL`
   - それ以外の12個 → `zone='OUTER'`, `state='LOCKED'`, `booth_id=NULL`, `source=NULL`
3. 中央4マスのうち**1マス**を参加ボーナスとして確定する
   - 対象マスは中央4マスから**ランダムに1つ**選ぶ
   - `state='ACHIEVED'`, `source='SIGNUP_BONUS'`, `assigned_at = achieved_at = now`
   - `booth_id` は **`pickSignupBonusBooth()` に委譲する**（下記）
4. 残る中央3マスは `state='EMPTY'`, `booth_id=NULL`, `source=NULL` のまま

**★ この時点で外側12マスは何も決まっていない。推薦計算は一切走らない。ここが本設計の要点である。**

## 参加ボーナスのブース決定

**決定ロジックは1関数に切り出し、差し替え可能にすること。**最終的な選定規則は未決定（[09-open-questions](../09-open-questions/open-questions.md) Q-4）。

```ts
// src/lib/bingo/pickSignupBonusBooth.ts
export async function pickSignupBonusBooth(
  db: DbClient,
  eventId: string,
  userId: string,
): Promise<string>  // booth_id
```

**既定実装（暫定・差し替え前提）:**

1. `booths` のうち `is_active = 1` のものを候補にする
2. そのイベントで**現時点の訪問者数が少ない順**に並べ、上位30%からランダムに1件選ぶ
3. 候補が0件なら `is_active = 1` の全ブースからランダム

この既定にする理由は2つ。人気ブースを配ると[成功の定義](../README.md)と逆行すること、および**ボーナスブースにその人が実際に訪問すると中央マスが1つ埋まらなくなる**ため（[D-11](../01-concept/decisions.md)）、訪問されにくいブースを選んだ方が解放の到達率が上がること。

**事前アンケート未回答でも必ず値を返すこと。**この関数は例外を投げてはならない。

## 冪等性

同一ユーザーに対する `ensureCard` の同時実行で、カードが2枚できたり中央マスが 16 行を超えたりしてはならない。

- `bingo_cards` の `UNIQUE (event_id, user_id)`
- `bingo_cells` の `UNIQUE (card_id, position)`

この2つが最終防衛線になる。INSERT が重複で落ちた場合は**読み直して返す**（例外を上げない）。

## 検証

カード生成直後に以下が成り立つこと。テストで固定する。

- `bingo_cells` が正確に16行、`position` は 0..15 が1つずつ
- `zone='CENTER'` が4行で `position` は {5,6,9,10}
- `state='ACHIEVED'` が **ちょうど1行**、その `source='SIGNUP_BONUS'`、`booth_id` が NOT NULL
- `state='EMPTY'` が3行（全て CENTER）、`state='LOCKED'` が12行（全て OUTER）
- カードの `status='CENTER_ONLY'`, `unlocked_at IS NULL`
