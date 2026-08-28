---
状態: 確定
最終更新: 2026-08-27
---

# テーブル定義（migration 10）

`gacha_coin_uses` は migration 09 で器だけ作られているが、**本番未投入のため作り直してよい**
（bingo の決定「本番DBは段階解放マイグレーション未適用」に準ずる）。

```sql
-- =============================================================================
-- 10_gacha_coins.sql
-- =============================================================================
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS gacha_coin_uses;
SET FOREIGN_KEY_CHECKS = 1;

-- コイン使用台帳（追記のみ。UPDATE / DELETE しない）
CREATE TABLE gacha_coin_uses (
  id              CHAR(36) PRIMARY KEY,
  event_id        CHAR(36) NOT NULL,
  user_id         CHAR(36) NOT NULL,
  coin_index      INT      NOT NULL,   -- 0 起点。そのユーザーの何枚目か
  idempotency_key CHAR(36) NOT NULL,   -- クライアント生成 UUID（G-5）
  used_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_gacha_coin (event_id, user_id, coin_index),
  UNIQUE KEY uk_gacha_idem (event_id, user_id, idempotency_key),
  INDEX idx_gacha_event_used_at (event_id, used_at),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);

-- イベントごとの換算規則（G-3）
CREATE TABLE gacha_settings (
  event_id       CHAR(36) PRIMARY KEY,
  is_enabled     TINYINT(1) NOT NULL DEFAULT 0,
  coins_per_line INT        NOT NULL DEFAULT 1,
  max_coins      INT        NOT NULL DEFAULT 4,
  bonus_coins    INT        NOT NULL DEFAULT 0,
  updated_at     DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
```

## 各列の意味

| 列 | 意味 |
|---|---|
| `coin_index` | `uk_gacha_coin` により、同一ユーザーが同じ枚数目を二重に消費できない。**多重消費に対する最後の砦** |
| `idempotency_key` | `uk_gacha_idem` により、同じ操作の再送が2行にならない |
| `is_enabled` | 0 のとき参加者 API は使用を `403` で拒否する（G-8） |
| `coins_per_line` | ライン1本あたりの枚数 |
| `max_coins` | 獲得の上限。**既定 4（G-11 で確定）**。1ライン1枚なので、4ライン以上は頭打ち |
| `bonus_coins` | 当日の裁量加算。既定 0。ライン数に関わらず全員に足される |

## 行が無いとき

`gacha_settings` に行が無いイベントでは、コード側の既定値
（`is_enabled = false, coins_per_line = 1, max_coins = 4, bonus_coins = 0`）を使う。
**設定行の有無で API が 500 になってはならない。**

## 消さないもの

`gacha_coin_uses` は分析（analytics）が「誰がいつ何枚目を使ったか」を復元する原資である。
イベント終了後も削除しない。運営画面の「イベントデータ全消去」の対象には含める。
