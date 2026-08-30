# 0006. ビンゴカード生成は「作る側1本」に寄せ、重複キーは例外にしない

- 日付: 2026-08-29
- ステータス: 承認

## コンテキスト

**症状。** サインアップ → オンボーディングを終えてホームへ遷移すると、ビンゴカードが表示されない。
そのままリロードすると初期状態のカードが表示される。`GET /bingo/card` が 1 回だけ 500 を返していた。

調査で **2 つの独立した欠陥**が見つかった。ホーム初回表示という同じ場面で重なるため、
片方だけ直しても症状は消えない。

### 欠陥 A（本症状の直接原因）: `pair_key` の桁が足りない

```
card_unlock_events.pair_key   VARCHAR(8)
挿入していた値                 'PRESURVEY'   ← 9 文字
```

事前アンケートに回答したユーザーは `position 5` に推薦ブースが載り、その記録として
`pair_key='PRESURVEY'` の行を作る（[signup.md](../../specs/bingo-dynamic-unlock/03-card-lifecycle/signup.md)）。
この INSERT が `ER_DATA_TOO_LONG` で落ち、**カードと16マスを作った直後に例外**になって 500 になっていた。

- リロードで直って見えるのは、1 回目の失敗までに `bingo_cards` と `bingo_cells` が作られているため。
  2 回目は既存カードを読むだけなので成功する
- **アンケート未回答のユーザーは踏まない。** `pickPreSurveyBooth` が `null` を返し、この INSERT に
  到達しないため。「アンケートに答えた新規ユーザーの初回表示だけ」という狭い条件だった
- MySQL が非 strict mode なら例外にならず `'PRESURVE'` に切り詰めて保存される。この場合 500 は
  出ない代わりに、カード取得の `WHERE pair_key <> 'PRESURVEY'` を素通りし、
  **事前推薦マスが解放演出として再生される**という別の不具合になる

### 欠陥 B（潜在）: `ensureCard` が同時に 2 本走り得た

`ensureCard` はカードの get-or-create だが、冪等性の担保が
`catch (err.code === 'ER_DUP_ENTRY')` に依存していた。[ADR 0001](./0001-sakura-proxy-error-masking.md)
のとおり、さくらプロキシは DB エラーを `code` の無い 500 に潰すため、**本番経路でだけこの
握り潰しが効かず 500 に化ける**。

そして呼び出し元が 2 つあった。ホーム初回表示で並行に走る:

| リクエスト | 呼び出し理由 |
|---|---|
| `GET /bingo/card` | カード本体。これは作る側で正しい |
| `GET /gacha/coins` | コイン残高の算出にライン数が要り、`countLines` から呼んでいた |

コイン枚数の問い合わせがビンゴカードを発行するのは責務として誤りで、かつ
「同一ユーザーの 2 リクエストがミリ秒差で並ぶ」唯一の経路だった。
（開発時は React StrictMode の二重マウントで `GET /bingo/card` 自体も 2 本飛ぶ。）

なお、本番はプロキシ経由・ローカルは mysql2 直結で、**重複キーの現れ方が違う**。
ローカルで再現しないから本番でも起きない、とは言えない。

## 決定

### 1. `pair_key` を `VARCHAR(16)` に広げる

[db/migrations/11_widen_unlock_pair_key.sql](../../../db/migrations/11_widen_unlock_pair_key.sql)。
通常の `pair_key` は `5-9` 形式で最長 5 文字。16 は `'PRESURVEY'` と将来の予約語に十分な幅。
`db/create-tables.sql` と `09_bingo_staged_unlock.sql` の DDL も同期する。

値を短くする案（`'PRE'` 等）は採らない。仕様書が `'PRESURVEY'` を明示しており、
スキーマ側を仕様に合わせるのが筋であるため。

### 2. get-or-create は `ON DUPLICATE KEY UPDATE` で書く

`ensureCard` の 3 つの INSERT（`bingo_cards` / `bingo_cells` / `card_unlock_events`）から
`try/catch (ER_DUP_ENTRY)` を全廃し、重複が**そもそも例外にならない**形にした。
INSERT のあとは必ず SELECT で読み直す（自分の INSERT が無視された可能性があるため）。
詳細は ADR 0001 の追記を参照。

`recommendation_scores` は一意制約を持たない追記テーブルなので、
`card_unlock_events` の `affectedRows === 1`（＝自分が挿入した）を条件に挿入する。
また、競合に負けた側は `position 5` に載っているのが相手の選んだブースになるため、
自分の候補ではなく**カードに実際に載ったブース**を読み直して記録する。

### 3. `GET /gacha/coins` からカード生成の副作用を外す

`countLines` を読み取り専用の `findCard` に変え、カードが無ければ `lines_completed: 0` を返す。
これで `ensureCard` の呼び出し元は `GET /bingo/card` と `POST /checkins` だけになり、
同一ユーザーの並行呼び出しが構造的に消える。カード未発行＝ライン 0 で意味的にも正しい。

## 結果・トレードオフ

- ホーム初回表示でカードが出ない症状は解消。ブラウザでサインアップから通して確認済み
- ユニットテストのフェイク DB を、**一意制約を実際に守り、`ON DUPLICATE KEY UPDATE` の無い
  INSERT が重複したら code の無い `[sakura-proxy] 500` を投げる**ものに作り替えた。
  例外ベースの実装へ戻すと競合系のテストが落ちる
- **欠陥 A はユニットテストでは原理的に検知できない。** フェイク DB はカラム長を再現しないため。
  同種のバグ（スキーマと定数の不一致）を防ぐには実 MySQL に対する統合テストが要る（未着手。下記）

## 今後考慮すること

1. **分析用の書き込みでカード表示を落とさない。**
   今回、`recommendation_scores` 用の記録（分析目的）が失敗しただけでビンゴカードが表示できなくなった。
   仕様は E1/E3 で「カード生成は必ず成功する」としているので、この記録の失敗は握り潰してカードは返すべき。
   ただしエラーが見えなくなるトレードオフがあるため未実装。**判断が必要。**

2. **ビンゴの統合テストが無い。**
   `tests/integration/` にあるのはガチャのみ。アンケート回答済みユーザーで `GET /bingo/card` が
   200 を返すことを実 MySQL に対して固定すれば、欠陥 A の型のバグを止められる。
   `tests/integration/gacha/helpers.ts` の仕組みが流用できる。

3. **プロキシに MySQL のエラー情報を返させる（ADR 0001 の根治）。**
   現在 `ER_DUP_ENTRY` を見ている箇所が 12 個あり、それぞれが個別の回避策を抱えている。
   PHP ラッパーが `errno` / `sqlstate` を返し `http-proxy.ts` がそれを `Error` に載せれば、
   この種のバグが構造的に発生しなくなる。さくら側の資産に手を入れる必要があるため、
   **本番後に実施**する判断。最も壊れると痛い `useCoin` は元からエラーコードに依存しない
   実装になっており、この対応抜きでも二重消費は防がれている。

4. **新しく一意制約や桁制限を持つカラムへ INSERT するときは、実 DB で 1 回通す。**
   欠陥 A は型検査も lint もユニットテストも素通りする。文字列定数がカラム定義に収まるかは
   実際に挿入してみるまで分からない。

5. **本番 DB へのマイグレーション適用を忘れない。**
   `11_widen_unlock_pair_key.sql` はさくら DB に未適用。非 strict mode では 500 が出ない代わりに
   静かに切り詰められるため、症状が出ていなくても適用が必要。

## 関連

- [ADR 0001](./0001-sakura-proxy-error-masking.md) — 追記「get-or-create は `ON DUPLICATE KEY UPDATE` を使う」
- [signup.md](../../specs/bingo-dynamic-unlock/03-card-lifecycle/signup.md) — 冪等性の節
- [edge-cases.md](../../specs/bingo-dynamic-unlock/08-edge-cases/edge-cases.md) — E17
- [participant-api.md](../../specs/gacha-and-award/04-api/participant-api.md) — `GET /gacha/coins` は副作用なし
