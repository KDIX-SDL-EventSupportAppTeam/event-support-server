# テスト実行記録 — 2026-08-28（ガチャコイン：換算・消費・排他・運営API）

## 何を

### 対象（src）

- `src/lib/gacha/coins.ts` — 換算の純関数 `calcCoinsEarned`
- `src/lib/gacha/settings.ts` — `gacha_settings` 取得とフォールバック
- `src/lib/gacha/useCoin.ts` — コイン消費の排他制御（HAVING 付き単一 INSERT ... SELECT）
- `src/routes/v1/gacha.ts` — 参加者 API（GET/POST coins）
- `src/routes/v1/organizer/gacha-settings.ts` — 運営の換算規則 API
- `src/routes/v1/admin/gacha.ts` — 当日モニタ stats
- `db/migrations/10_gacha_coins.sql` / `db/create-tables.sql` — スキーマ

### テストコード（tests）

- `tests/unit/gacha/coins.test.ts`（新規）— 264通り総当たり＋確定値の固定表＋単調非減少＋境界＋不変性＋依存の向き
- `tests/unit/gacha/settings.test.ts`（新規）— フォールバック
- `tests/integration/gacha/helpers.ts`（新規）— 結合テスト共通ヘルパー
- `tests/integration/gacha/use-coin.test.ts`（新規）— concurrency.md C-1〜C-10＋「起きてはいけないこと」
- `tests/integration/gacha/settings.test.ts`（新規）— 運営 API のバリデーション・監査ログ・stats

## なぜ

`docs/specs/gacha-and-award/`（状態: 確定）の実装。多重消費（1操作で2枚減る／
本来使えないのに使える）が起きると当日取り返しがつかないため、排他・冪等の
結合テストに重心を置く（10-testing/README.md）。

## 実行コマンド

```bash
docker compose up -d mysql
docker exec -i event-support-mysql mysql -uroot -pdevroot event_support < db/migrations/10_gacha_coins.sql
npm run db:check
npm run build
npm test
```

## 環境

- ブランチ: `feat/gacha-coins`（`develop` 宛て PR 予定）
- MySQL: 起動済み（docker compose `event-support-mysql`, MySQL 8.0.46）
- 関連 PR / Issue: —

## 結果

- 成功。サーバー: `npm run build` OK、`npm test` 全通過（ガチャ結合を含む）。
  フロント: `npm run build` / `npm run lint`(0 error) / `npm test`(109) OK。
- 内訳（ガチャ分・サーバー）:
  - 単体: `coins.test.ts` 312（264総当たり＋固定表11＋単調非減少24＋境界＋不変性）、`settings.test.ts` 5
  - 結合: `use-coin.test.ts` 24（GET 堅牢性 3 ＋ C-1〜C-10 ＋ 起きてはいけないこと 3）、`settings.test.ts` 7
- C-4（別キー並行5回・残高3枚）はローカル MySQL への真の並行で
  「1回だけ再試行」では最後の1枠を敗者2本が奪い合うと収束せず 500 になることがあった。
  spending.md の「1回だけ」はさくらプロキシ（HTTP 直列化）前提の最小値と解釈し、
  `useCoin` の再試行を「衝突が解消するまで（COUNT 単調増加で必ず収束、上限25の保険つき）」に変更。
  C-3 の「500 が返らない」と両立する。5連続実行で C-4 安定通過を確認。
- マイグレーション 10 を同一 DB へ2回連続適用してエラーが出ないことを確認。
- `npm run db:check` は 21 テーブル（`gacha_settings` を追加）で OK。

## メモ

- 結合テストはローカル MySQL 必須（`docker compose up -d mysql`）。未起動なら
  `assertDbReachable` が理由付きで落ちる。
- 実機リハーサル（`10-testing/rehearsal-plan.md`）はビンゴのリハーサルに相乗りで別途実施。
