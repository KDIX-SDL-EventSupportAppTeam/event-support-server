# フォールバック割当

**推薦サービスがタイムアウト・エラー・不足を返した場合でも、解放は必ず成功させる。参加者を `LOCKED` のまま放置しない。**

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

- `strategy = 'FALLBACK_COVERAGE'`、`score = NULL`、`reason_payload` には `{"kind":"fallback","visitors":n}` を入れる
- 訪問者数の集計から**スタッフ（`users.role <> 'participant'`）を除外する**（E11）
- 同数の場合は `RAND()` で散らす。全員に同じ12マスが配られるのを防ぐ

## 人気順にしてはならない（重要）

**このアプリの成功の定義は踏破率でも総訪問数でもない。**「参加者が自分では選ばなかったであろうブースを訪問し、それが本当に新しい興味・マッチングになること」である。

人気ブースを全員に薦めれば踏破率は上がるが、**それは失敗である。**去年、フォールバック解除が早すぎた（累計CI 約60件、1ブース1.5人）結果、推薦は事実上ブース人気度ランキングに退化し、上位は飲食ブースと制作チーム自身のブースだった。誰にでも当たる推薦であり、研究目的に一切寄与していない。

訪問者数の少ない順にすることで、少なくとも「自分では選ばなかったブース」という条件は満たす。

## self-healing

`GET /events/:event_id/bingo/card` は、**`status='UNLOCKED'` なのに `state='LOCKED'` のマスが残っている**カードを検知したら、その場でフォールバック割当を実行して修復する。解放処理の途中で DB エラーが起きた場合の回復経路である（[03-card-lifecycle/unlock.md](../03-card-lifecycle/unlock.md)）。

修復した場合も `cell_assignment_logs` を必ず記録する（`global_checkin_count` はその時点の値）。
