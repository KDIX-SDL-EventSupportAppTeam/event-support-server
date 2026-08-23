---
状態: 確定
最終更新: 2026-08-24
---

# フォールバック割当

**推薦サービスがタイムアウト・エラー・不足を返した場合でも、解放は必ず成功させる。
参加者を「見えないマス」のまま放置しない。**

## 割当規則

未訪問ブースから、**そのイベントでの訪問者数が少ない順に**必要件数を選ぶ。

```sql
SELECT b.id, COUNT(ci.id) AS visitors
FROM booths b
LEFT JOIN check_ins ci ON ci.booth_id = b.id AND ci.event_id = b.event_id
LEFT JOIN users u ON u.id = ci.user_id AND u.role = 'participant'
WHERE b.event_id = ? AND b.is_active = 1 AND b.id NOT IN (…exclude…)
GROUP BY b.id
ORDER BY visitors ASC, RAND()
LIMIT ?
```

- `strategy = 'FALLBACK_COVERAGE'`、`score = NULL`
- 訪問者数の集計から**スタッフ（`users.role <> 'participant'`）を除外する**
- 同数の場合は `RAND()` で散らす。全員に同じマスが配られるのを防ぐ
- `recommendation_scores` には**候補全件**を記録する。`score` は NULL、
  `rank_in_event` は訪問者数の少ない順の順位を入れる

## 人気順にしてはならない（重要）

**このアプリの成功の定義は踏破率でも総訪問数でもない。**
「参加者が自分では選ばなかったであろうブースを訪問し、それが本当に新しい興味・マッチングになること」である。

人気ブースを全員に薦めれば踏破率は上がるが、**それは失敗である。**
去年、フォールバック解除が早すぎた（累計約60件、1ブース1.5人）結果、
推薦は事実上ブース人気度ランキングに退化し、上位は飲食ブースと制作チーム自身のブースだった。
誰にでも当たる推薦であり、研究目的に一切寄与していない。

訪問者数の少ない順にすることで、少なくとも「自分では選ばなかったブース」という条件は満たす。

## COVERAGE フェーズとの関係

[phases.md](phases.md) の `COVERAGE` フェーズは、このフォールバックと同じ規則に
「関心分野が一致するブースを優先する」を足したものである。

- 決定表が育っていない時間帯（開場直後）の正規の戦略
- 推薦サービスが落ちたときの緊急退避

**同じ関数を使い回してよいが、`strategy` の値で区別して記録する**
（`COVERAGE_INTEREST` / `FALLBACK_COVERAGE`）。後から「正常時か障害時か」を分離して分析するため。

## 自己修復

カード取得 API は、**解放イベントが存在するのに `released_positions` のマスが
`is_revealed = 0` である**カードを検知したら、その場でフォールバック割当を実行して修復する。
解放処理の途中で DB エラーが起きた場合の回復経路である（[unlock.md](../03-card-lifecycle/unlock.md)）。

- **解放イベントごとに独立して点検する。** 3回ぶんすべてを見る
- 修復した場合も `recommendation_scores` を必ず記録する
  （`strategy='SELF_HEAL'`、`global_checkin_count` はその時点の値）

## テストで固定すること

- 推薦サービスを 500 にしても解放が成功し、マスが埋まる
- 推薦サービスをタイムアウトさせても解放が成功する
- フォールバックの選定にスタッフのチェックインが含まれない
- 訪問者数が同じブースが複数あるとき、毎回同じ順序にならない
- 解放イベントだけ作ってマスを未開放にした状態でカードを取得すると、修復される
