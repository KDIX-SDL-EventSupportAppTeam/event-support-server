---
状態: 確定
最終更新: 2026-08-27
---

# 合格基準

**「テストする」ではなく、判定条件まで書き切る。** 実装が終わったら上から順に埋める。

## マイグレーション

- [ ] `10_gacha_coins.sql` 適用後、`gacha_coin_uses` に `uk_gacha_coin` と `uk_gacha_idem` が存在する
- [ ] `gacha_settings` が存在し、既定値が `is_enabled=0, coins_per_line=1, max_coins=4, bonus_coins=0`
- [ ] `npm run db:check` が通る
- [ ] 再適用（2回実行）してもエラーにならない
- [ ] イベント削除で `gacha_coin_uses` / `gacha_settings` が CASCADE で消える

## 換算

- [ ] [unit-coverage.md](unit-coverage.md) の 264 通りが全部通る
- [ ] 確定値 `1枚/ライン・上限4枚` の固定表（lines 0..10 → 0,1,2,3,4,4,4,4,4,4,4）が一致する
- [ ] `src/lib/bingo/` 配下に `gacha` の文字列が1件も無い（依存の向き。G-4）
- [ ] `src/routes/v1/gacha.ts` から `MAX_COINS` のハードコードが消えている
- [ ] ビンゴカード API が `coins` を返さない（既存の bingo 合格基準の再確認）

## 参加者 API

- [ ] GET が `is_enabled / lines_completed / earned / used / available / max_coins` を返す
- [ ] `gacha_settings` の行が無いイベントでも GET が `200`
- [ ] カード未発行のユーザーが GET してもエラーにならない（`ensureCard` される）
- [ ] POST 成功で `coin_index` と `used_at` が返る
- [ ] POST 成功後の GET の `used` が、POST 応答の `used` と一致する

## 排他・冪等

- [ ] [concurrency.md](concurrency.md) の C-1 〜 C-10 が全部通る
- [ ] **同一冪等キーの並行2回で行が1行**
- [ ] **残高1枚に対する別キー並行2回で成功1本**
- [ ] どのケースでも `used > earned` の行が生まれない

## 運営 API

- [ ] `organizer` 以外の権限で settings の PUT が `403`
- [ ] 範囲外の値（`max_coins = -1`, `coins_per_line = 11`）で `400`
- [ ] 変更が `audit_logs` に1行残る（変更前後の値つき）
- [ ] 行が無い状態への PUT が INSERT として成立する
- [ ] stats の `total_used` が台帳の行数と一致する

## フロントエンド

- [ ] `/gachapon` `/gachapon/use` `/gachapon/complete` が `LegacyPlaceholderPage` でなくなっている
- [ ] `ApiParticipantClient` からガチャのスタブ2本が**消えている**
- [ ] 「使用する」の二重タップで API 呼び出しが1回
- [ ] 通信エラー後の再試行で**同じ冪等キー**が送られる（ネットワークログで確認）
- [ ] `409` で「他の端末で使い切った可能性」の文言が出て、枚数が再取得される
- [ ] `403` で「準備中」表示になる
- [ ] 残り0枚のとき使用ボタンが**表示されない**（disabled ではなく非表示）
- [ ] 完了画面に「何枚目・何時何分・残り何枚」が出る
- [ ] 完了画面からブラウザバックで使用確認画面に**戻れない**（履歴が置換されている）
- [ ] スタッフに関する文言・画面・API が**どこにも無い**（`grep -ri "スタッフ" src/features/gachapon` が空）
- [ ] ホームのボタンが `available` を表示し、0 枚で無効
- [ ] 旧 Flask のエンドポイント文字列がリポジトリ内に1件も残っていない

## 性能

- [ ] GET が本番相当データ量で 500ms 以内
- [ ] POST が 1秒以内
- [ ] admin stats が参加者 API と同時に走っても参加者側の応答が劣化しない
