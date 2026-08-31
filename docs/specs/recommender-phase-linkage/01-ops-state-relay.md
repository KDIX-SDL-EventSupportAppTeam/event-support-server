---
状態: 確定
最終更新: 2026-09-01
---

# 中継エンドポイント

## 定義

```
GET /api/v1/admin/events/:event_id/recommender/state
```

- 認可: 運営（admin）。既存の `/admin/*` と同じガード
- 監査ログ: **不要**（読み取りのみ・状態を変えない）

## 環境変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `RECOMMENDER_URL` | 空 | 既存。空なら中継せず `available: false` を返す |
| `RECOMMENDER_OPS_TOKEN` | 空 | **新規。** 推薦側の `OPS_TOKEN` と同一の秘密 |
| `RECOMMENDER_STATE_TIMEOUT_MS` | 2000 | **新規。** 中継のタイムアウト。解放経路の1000msとは別物 |

**推薦側の `OPS_TOKEN` と同じ値を入れる。** 分析リポジトリの `RECOMMEND_OPS_TOKEN` とも同一。
3者が同じシークレットを参照する。

## 呼び方

- `GET {RECOMMENDER_URL}/ops/state` に `X-Ops-Token` ヘッダを付ける
- **`Authorization` は使わない**（Cloud Run の IAM 認証と層が衝突するため）
- タイムアウトは `AbortController` で中断する（`recommenderClient.ts` と同じ流儀）

## キャッシュ

**同一プロセス内で 10 秒間キャッシュする。**

- ダッシュボードは WebSocket で頻繁に再取得する。素通しすると推薦エンジンに無用な負荷がかかる
- 10秒は「当日の判断に間に合う」かつ「連打しても増えない」値
- キャッシュはイベント単位ではなく**プロセス単位**でよい（推薦エンジンは1イベントしか見ない）

## 応答

推薦エンジンの `/ops/state` を**そのまま**入れる。サーバーは値を作らない。

```json
{
  "available": true,
  "fetched_at": "2026-10-16T01:23:45.000Z",
  "state": { "...": "/ops/state の応答をそのまま" }
}
```

到達できないときは、**理由を区別して**返す。

```json
{ "available": false, "reason": "UNCONFIGURED", "fetched_at": "..." }
```

| `reason` | いつ | 当日の意味 |
|---|---|---|
| `UNCONFIGURED` | `RECOMMENDER_URL` が空 | 結線していない。**設定漏れ** |
| `UNAUTHORIZED` | 401 / 403 | **トークンの不一致。こちらの設定ミス** |
| `UNREACHABLE` | 接続失敗・タイムアウト | 推薦エンジンが落ちているか、ネットワーク |
| `BAD_RESPONSE` | JSON でない・形が違う | バージョン不一致を疑う |

**「設定漏れ」と「エンジン停止」が同じ表示になってはならない。**
当日、切り分けができなくなる。

## 起きてはいけないこと

- **到達できないときに、サーバーが計算した値を `state` に入れて返すこと**
- **`RECOMMENDER_OPS_TOKEN` の値を応答やログに出すこと**
- **中継の失敗を 500 にすること。** 200 で `available: false` を返す。
  ダッシュボードは他の集計を表示し続けなければならない
