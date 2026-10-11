---
状態: 確定
最終更新: 2026-10-11
---

# 出展者一覧とロール変更（運営画面）

運営画面に「出展者一覧」（`/admin/exhibitors`）と、参加者 ⇄ 出展者のロール変更を追加する。
フロントとの合意済み（2026-10-11）。実装は `src/routes/v1/admin/exhibitors.ts`。

## GET `/api/v1/admin/events/:event_id/exhibitors`

- 権限: 運営（manager / viewer）。他イベントの JWT は 403
- 対象: `users.event_id = :event_id AND users.role = 'exhibitor'`
- **ブース単位にまとめ、並び順はサーバーで決める**（フロントは並べ替えない）
  - `booths` は `display_code` の自然順（`'2' < '10'`）。同じ番号ならブース名順
  - `display_code` が null のブースは末尾に置き、ブース名順
  - 出展者が1人もいないブースは含めない
  - 各ブースの `exhibitors` はメールアドレスの昇順
  - どのブースにも紐付いていない出展者は `unassigned`（メールアドレスの昇順）
  - 複数ブースを担当する出展者は、それぞれのブースに重複して出る

```json
{
  "data": {
    "booths": [
      {
        "booth_id": "uuid",
        "booth_name": "近畿大学 須藤ゼミ",
        "display_code": "1",
        "exhibitors": [
          { "user_id": "uuid", "email": "a@example.com", "display_name": "山田", "created_at": "2026-10-01T00:00:00.000Z" }
        ]
      }
    ],
    "unassigned": [
      { "user_id": "uuid", "email": "b@example.com", "display_name": null, "created_at": "2026-10-01T00:00:00.000Z" }
    ]
  }
}
```

## PATCH `/api/v1/admin/events/:event_id/users/:user_id/role`

- 権限: **manager のみ**（viewer・participant・exhibitor は 403）
- ボディ（どちらか）
  - 参加者 → 出展者: `{ "role": "exhibitor", "booth_ids": ["uuid", ...] }`（1件以上・重複は1件に畳む）
  - 出展者 → 参加者: `{ "role": "participant" }`
- レスポンス: `{ "data": { "user_id": "uuid", "role": "exhibitor" | "participant" } }`

### 処理

| 変更 | 受け付ける現在のロール | 書き込み |
|---|---|---|
| → exhibitor | `participant` のみ | `users.role='exhibitor'`。`exhibitor_booths` に紐付けを作る（既にある組はスキップ）。パスワードは触らない |
| → participant | `exhibitor` のみ | `users.role='participant'`。そのユーザーの `exhibitor_booths` を全削除。`email_verified_at` が NULL なら現在時刻を入れる（運営が本人確認した扱い） |

- ロールの更新は条件付き UPDATE（`WHERE role = <変更前>`）で行い、`affectedRows = 0` なら 409（同時更新）
- `getConnection` が使える環境では1トランザクション。使えない環境（さくらプロキシ）では順次実行し、失敗したら 500 を返す
- 監査ログ: `action = 'user.role_change'`、`target_type = 'user'`、`target_id = user_id`、
  `detail = { email, from, to, booth_ids? }`

### エラー

| 状況 | ステータス | code |
|---|---|---|
| ボディが不正（`booth_ids` が空・UUID でない・role が不正） | 422 | `VALIDATION_ERROR` |
| 対象ユーザーがいない／別イベントのユーザー | 404 | `NOT_FOUND` |
| 存在しないブース／別イベントのブースを指定 | 404 | `NOT_FOUND` |
| 運営アカウント（manager / viewer / admin）が対象 | 409 | `CONFLICT` |
| 現在のロールが変更前として想定と違う（例: 既に exhibitor） | 409 | `CONFLICT` |

フロントはエラーの `message` をそのまま表示する。

## ロール変更後のトークン

再ログインは不要。出展者向け API は JWT の role ではなく DB（`users.role` と `exhibitor_booths`）で判定する
（`src/lib/exhibitor.ts`）。フロントは出展者メニューの表示を `GET /events/:event_id/exhibitor/booths` の
`is_exhibitor` で判定する。

## 参加者向け API と出展者

参加者向け API（`/events/:event_id/...`）は role で拒否しない。出展者も参加者画面を使える。
出展者を事前アンケートの対象外にする判定はフロントが行う。
出展者のチェックイン・評価は、ダッシュボード・ビンゴの来場者数・ガチャ集計（`role='participant'` で絞る）から外れる。
参加者だったときのデータは、出展者にしても削除しない。
