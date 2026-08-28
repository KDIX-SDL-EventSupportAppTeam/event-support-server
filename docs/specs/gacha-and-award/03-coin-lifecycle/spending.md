---
状態: 確定
最終更新: 2026-08-27
---

# 消費と排他制御

**本仕様で最も壊れやすい箇所。** 本番 DB は 1リクエスト = 1SQL で、
トランザクションも行ロックも無く、さらにプロキシが `ER_DUP_ENTRY` を 500 に潰す
（[ADR 0001](../../../decisions/adrs/0001-sakura-proxy-error-masking.md)、
`src/lib/bingo/assignOuterCells.ts:156` の既知の制約）。

素の `INSERT` では、二重タップでも通信リトライでも1枚多く消える。

## 手順

1. `gacha_settings` を読む。`is_enabled = 0` なら `403 GACHA_DISABLED` で終了
2. ビンゴカードから `lines` を求め、`earned = calcCoinsEarned(lines, settings)` を算出
3. 次の **単一 SQL** を実行する

```sql
INSERT INTO gacha_coin_uses (id, event_id, user_id, coin_index, idempotency_key)
SELECT ?, ?, ?, COUNT(*), ?
  FROM gacha_coin_uses
 WHERE event_id = ? AND user_id = ?
HAVING COUNT(*) < ?     -- ? = 手順2の earned
```

| 結果 | 意味 | 応答 |
|---|---|---|
| `affectedRows = 1` | 消費成立 | `200`（`coin_index` と `used_at` を返す） |
| `affectedRows = 0` | `HAVING` 不成立＝残高ゼロ | `409 NO_COINS_AVAILABLE` |
| 例外（プロキシ経由では 500） | ユニーク制約違反の可能性 | 手順4へ |

4. **例外時の判定**: `idempotency_key` で SELECT する
   - 行がある → その操作は**成立している**。`200` を返す（再送・並行の勝者側の行）
   - 行が無い → `uk_gacha_coin` の衝突（同時実行の敗者）。**1回だけ手順2から再試行**する。
     再試行も失敗したら `500` を返す

## なぜこれで守れるか

| 攻撃 | 防ぐ仕組み |
|---|---|
| ボタン二重タップ（同じ冪等キー） | `uk_gacha_idem`。2本目は例外 → 手順4で既存行を見つけて `200` |
| 通信エラー後の再送（同じ冪等キー） | 同上。**枚数は増えない** |
| 連打で別キーが2本（並行） | `uk_gacha_coin`。両方が `COUNT(*) = n` を読んでも `coin_index = n` は1行しか入らない |
| 残高ゼロでの使用 | `HAVING COUNT(*) < earned` |
| `earned` を読んだ直後にラインが増えた | 過小評価にしかならない（単調非減少）。損はしても超過はしない |

## やってはならないこと

- 残高カラムを作って `UPDATE ... SET coins = coins - 1` にすること
- `SELECT` で残高を確認してから別リクエストで `INSERT` すること（間に割り込まれる）
- 冪等キーをサーバー側で生成すること（再送が別操作になり、意味を失う）
- 例外を握りつぶして `200` を返すこと（手順4の SELECT を必ず通す）

## 取り消し

**コインの使用は取り消せない。** 誤使用の救済は `bonus_coins` を運営が +1 する運用で行う。
台帳から行を消す運用を作らない（分析データが壊れるため）。
