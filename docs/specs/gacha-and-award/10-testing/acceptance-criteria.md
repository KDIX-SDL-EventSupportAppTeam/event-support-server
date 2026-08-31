---
状態: 確定
最終更新: 2026-08-28
---

# 合格基準

**「テストする」ではなく、判定条件まで書き切る。** 実装が終わったら上から順に埋める。

凡例:
- `[x]` = **自動テスト or grep で機械的に検証済み**（回帰したら CI が落ちる）
- `[ ]` = 未検証。コードは書いてあっても、機械的な裏付けが無いものはここに置く

**「実装したから [x]」にしない。** 落ちない検証は検証ではないため。

## マイグレーション

- [x] `10_gacha_coins.sql` 適用後、`gacha_coin_uses` に `uk_gacha_coin` と `uk_gacha_idem` が存在する（`SHOW CREATE TABLE` で確認）
- [x] `gacha_settings` が存在し、既定値が `is_enabled=0, coins_per_line=1, max_coins=4, bonus_coins=0`
- [x] `npm run db:check` が通る（21 テーブル）
- [x] 再適用（2回連続実行）してもエラーにならない
- [x] イベント削除で `gacha_coin_uses` / `gacha_settings` が CASCADE で消える（FK 定義＋結合テストの cleanup が依存）

## 換算

- [x] [unit-coverage.md](unit-coverage.md) の 264 通りが全部通る（`tests/unit/gacha/coins.test.ts`）
- [x] 確定値 `1枚/ライン・上限4枚` の固定表（lines 0..10 → 0,1,2,3,4,4,4,4,4,4,4）が一致する
- [x] `src/lib/bingo/` 配下に `gacha` の文字列が1件も無い（grep＋単体テストで静的検査。G-4）
- [x] `src/routes/v1/gacha.ts` から `MAX_COINS` のハードコードが消えている
- [x] ビンゴカード API が `coins` を返さない（bingo 側は未変更。ガチャの概念を持ち込んでいない）

## 参加者 API

- [x] GET が `is_enabled / lines_completed / earned / used / available / max_coins` を返す
- [x] `gacha_settings` の行が無いイベントでも GET が `200`（`use-coin.test.ts` GET 堅牢性）
- [x] カード未発行のユーザーが GET してもエラーにならず、カードを作らない
- [x] POST 成功で `coin_index` と `used_at` が返る
- [x] POST 成功後の GET の `used` が、POST 応答の `used` と一致する

## 排他・冪等

- [x] [concurrency.md](concurrency.md) の C-1 〜 C-10 が全部通る（`tests/integration/gacha/use-coin.test.ts`）
- [x] **同一冪等キーの並行2回で行が1行**（C-1）
- [x] **残高1枚に対する別キー並行2回で成功1本**（C-3。500 が返らない）
- [x] どのケースでも `used > earned` の行が生まれない（「起きてはいけないこと」）

## 運営 API

- [x] `organizer` 以外の権限で settings の PUT が `401/403`
- [x] 範囲外の値（`max_coins=-1/51`, `coins_per_line=11`, `bonus_coins=11`, 小数, 欠落）で `400`
- [x] 変更が `audit_logs` に1行残る（`target_type='gacha_settings'`、変更前後の値つき）
- [x] 行が無い状態への PUT が INSERT として成立する
- [x] stats の `total_used` が台帳の行数と一致する（`used_by_hour` の合計とも一致）

## フロントエンド

機械的に検証できたもの:

- [x] `/gachapon` `/gachapon/use` `/gachapon/complete` が `LegacyPlaceholderPage` でなくなっている
- [x] `ApiParticipantClient` からガチャのスタブ2本が**消えている**（`ParticipantClient` 型・Sample 実装からも削除。型で担保）
- [x] `gachaClient` が**渡された冪等キーをそのまま送る**（サーバー生成しない。`tests/unit/gacha-client.test.ts`）
- [x] エラーコード定数が `participant-api.md` と一致する（同上）
- [x] スタッフに関する文言・画面・API が**どこにも無い**（`grep -ri "スタッフ" src/features/gachapon` が空）
- [x] 旧 Flask のエンドポイント文字列がリポジトリ内に1件も残っていない

**実装済みだが自動検証が無いもの。** React コンポーネントの挙動であり、frontend の
テストは `environment: 'node'`（jsdom / Testing Library 無し）のため現状は書けない。
**実機リハーサルで必ず目視確認する**（コードを読んで正しいことと、落ちる検証があることは別）:

- [ ] 「使用する」の二重タップで API 呼び出しが1回（押下直後に `disabled`）
- [ ] 通信エラー後の再試行で**同じ冪等キー**が送られる（ネットワークログで確認）
- [ ] `409` で「他の端末で使い切った可能性」の文言が出て、枚数が再取得される
- [ ] `403` で「準備中」表示になる
- [ ] 残り0枚のとき使用ボタンが**表示されない**（disabled ではなく非表示）
- [ ] 完了画面に「何枚目・何時何分・残り何枚」が出る
- [ ] 完了画面からブラウザバックで使用確認画面に**戻れない**
- [ ] ホームのボタンが残り枚数を表示し、0 枚で無効
- [ ] 実機（スマホ）で「素早く2回タップ」「機内モード→復帰で再試行」を確認

## 性能

- [ ] GET が本番相当データ量で 500ms 以内（負荷確認は当日準備で実施）
- [ ] POST が 1秒以内
- [ ] admin stats が参加者 API と同時に走っても参加者側の応答が劣化しない（別クエリ設計。実測は負荷確認で）
