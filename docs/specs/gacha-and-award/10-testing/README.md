---
状態: 確定
最終更新: 2026-08-27
---

# テスト仕様

ガチャコインで壊れると**取り返しがつかない**のは1点だけ。
**「1回の操作で2枚消える」「本来使えないのに使える」という枚数の破れ。**
イベントは 2026-10-16 の1日限りで、コインを返す運用は用意しない（[spending.md](../03-coin-lifecycle/spending.md)）。
テストの重心をここに置く。

| ファイル | 内容 |
|---|---|
| [acceptance-criteria.md](acceptance-criteria.md) | 合格基準チェックリスト |
| [unit-coverage.md](unit-coverage.md) | 純関数で網羅する組み合わせ |
| [concurrency.md](concurrency.md) | 多重消費を殺すための結合テスト（最重要） |
| [rehearsal-plan.md](rehearsal-plan.md) | 実機リハーサルの手順 |

## 3つの層

| 層 | 何を守るか | 手段 | 実行 |
|---|---|---|---|
| **1. 純関数の単体テスト** | 換算規則そのもの | Vitest。DB も通信も使わない | 自動・毎回 |
| **2. API の結合テスト** | 台帳・排他・冪等 | Vitest + ローカル MySQL（docker compose） | 自動・毎回 |
| **3. 実機リハーサル** | 人間が触ったときに壊れないか | 手順書 + 人力 | 手動・節目ごと |

## テストしやすい設計にする（実装制約）

**換算を DB にも通信にも触れない純関数として切り出す**（G-4）。

```
lines: number, settings: GachaSettings
        ↓ calcCoinsEarned（純関数）
earned: number
```

台帳の読み書き・設定の取得・認証は、この関数の外側に置く。

## 置き場所

```
tests/unit/gacha/coins.test.ts            … 層1
tests/integration/gacha/use-coin.test.ts  … 層2
tests/integration/gacha/settings.test.ts  … 層2
```

`src/` に `*.test.ts` を置かない（[rules](../../../rules/README.md)）。
実行後は `docs/tests/runs/YYYY-MM-DD-*.md` に記録を残す。

## 自動化しないと決めたもの

- ガチャポン筐体を実際に回すこと
- 画面の見た目・アニメーション
- ガチャポン筐体を回す動作そのもの（アプリ外）

## 前提の切り分け

**ビンゴのライン計算はガチャのテスト対象ではない。** 結合テストではビンゴの
セル達成状態を直接セットアップして `lines` を作り、`countCompletedLines` の正しさは
bingo 側のテストに委ねる（依存の向きを、テストでも守る）。
