# クールタイム

## 仕様

- 同一ユーザーの直前チェックインから **60秒**（既定）以内の新規チェックインを拒否する
- 環境変数 `CHECKIN_COOLDOWN_SEC` で変更可能（`src/config.ts` の `envSchema` に `z.coerce.number().default(60)` で追加）
- 抵触時は **HTTP 429**、`result: 'COOLDOWN'`、`cooldown_remaining_sec` に残り秒数（切り上げ）を返す

## 判定

```sql
SELECT checked_in_at FROM check_ins
WHERE user_id=? AND event_id=? ORDER BY checked_in_at DESC LIMIT 1
```

**判定には `checked_in_at` ではなくサーバー現在時刻との差を使う。** `checked_in_at` はクライアントが送ってくる値であり、オフラインキューからの遅延送信では過去時刻が入る（[07-frontend の offline-queue 参照](../../../../event-support-frontend/docs/.sdd/04-offline/offline-queue.md)）。

- 直前レコードの `checked_in_at` と**サーバーの now** を比較する
- オフラインキューがまとめて flush された場合、2件目以降は 429 になりうる。**この場合はクールタイムを適用しない**：`checked_in_at` の差が 60 秒以上あるならユーザーの実際の行動としては正当だからである
- 実装上のルール: **`now - 直前の checked_in_at < COOLDOWN` かつ `今回の checked_in_at - 直前の checked_in_at < COOLDOWN` の両方を満たす場合のみ拒否する**

## なぜ60秒なのか

去年は 金180秒 / 土60秒で運用した。180秒はチェックイン間隔中央値（金5.6分）の下限として効いており、**データを歪めていた**（飽和24.2%）。土曜の実測 3.4分が実態に近い。60秒なら通常の行動を妨げない。

値を変えると解放到達時間（3件 × 間隔）が変わるため、**本番当日に安易に変更しないこと。**変更する場合は運営と合意した上で環境変数で行う。
