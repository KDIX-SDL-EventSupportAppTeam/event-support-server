---
状態: 確定
最終更新: 2026-09-01
---

# 推薦フェーズの連携

**運営ダッシュボードに出るフェーズを、推薦エンジンの実際の状態と一致させる。**

## 何が問題なのか

サーバーは現在、推薦エンジンに聞かずに**自分でフェーズを計算している。**

```ts
// src/routes/v1/admin/dashboard.ts
const decisionTableSize = bingoRatings          // 評価件数
const currentPhase = determinePhase(decisionTableSize)
```

推薦エンジン側は段3・段4 が未結線のため、**実際には常に `COVERAGE` で動いている。**
その結果、当日こうなる。

> 画面: 「現在のフェーズ: SIMILARITY」
> 実際: COVERAGE で推薦している

**当日この画面を見て判断するので、これは単なる表示のズレでは済まない。**
さらに推薦エンジンが段3・段4 を実装した後も、独自計算が残っていれば
「推薦エンジンが退避して COVERAGE に落ちた」ことを画面が隠してしまう。

## 決定

**フェーズの正本は推薦エンジンの `/ops/state` だけとする。サーバーは計算しない。**

```
[event-support-recommend]  GET /ops/state   ← 唯一の正本
        │ X-Ops-Token
        ▼
[event-support-server]  GET /api/v1/admin/events/:event_id/recommender/state   ← 中継するだけ
        │
        ▼
[event-support-frontend]  運営ダッシュボード
```

- サーバーは**中継役に徹する**。値を作らない・補正しない・推測しない
- 推薦エンジンに届かないときは、**推測値を出さず「取得不能」を返す**。
  ここでサーバーが代わりに計算すると、今と同じ嘘が復活する
- 分析リポジトリは既に `/ops/state` を直接読む実装になっている。**そちらは変更不要**

## 読む順序

| # | ファイル | 内容 |
|---|---|---|
| 01 | [ops-state-relay](01-ops-state-relay.md) | 中継エンドポイントの定義 |
| 02 | [dashboard-and-contract](02-dashboard-and-contract.md) | 独自計算の廃止と、推薦レスポンス契約の不一致修正 |
| 10 | [testing](10-testing.md) | **テスト項目** |

## 関連する正本

- 推薦側の実装仕様: `event-support-recommend/docs/specs/runtime-phase-switching/`
- 推薦との HTTP 契約: [bingo-dynamic-unlock/05-recommender/contract.md](../bingo-dynamic-unlock/05-recommender/contract.md)（**このリポジトリが正本**）
- フェーズ定義: `event-support-recommend/docs/specs/03-phases.md`

## 絶対に守る制約

1. **サーバーはフェーズを計算しない。** `determinePhase` を運営ダッシュボードから外す
2. **取得できないときに推測値を返さない。** 「取得不能」は正しい答えである
3. **中継の失敗でダッシュボード全体を落とさない。** 他の集計は今までどおり返す
4. **`OPS_TOKEN` をレスポンスに含めない。** 中継するのは状態だけ
