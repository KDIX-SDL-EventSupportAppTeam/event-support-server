---
状態: 確定
最終更新: 2026-09-10
---

# アワード投票 API（issue #124）

**今年アワード投票をアプリ内で実施する**（2026-09-10 決定。frontend #89 案 B）。
投票できるのは**その参加者がチェックイン済みのブースだけ**。
「チェックイン済み」の照合は **必ずサーバーで行う**（UI の選択肢制限は表示の都合であって関門ではない）。

## データモデル（migration `14_award_vote.sql`）

| テーブル | 役割 |
|---|---|
| `awards` | 賞の定義（運営が登録）。`id / event_id / name / description / color / sort_order` |
| `award_votes` | 投票。`UNIQUE (award_id, user_id)` で 1参加者×1賞=1票。付け替えは UPDATE |
| `award_settings` | 投票の開閉。`event_id PK / is_open`。**行が無いイベントの既定は `is_open = 0`** |

`db/create-tables.sql` にも同じ定義がある（24 テーブル）。

## 参加者向け

`preHandler`: `requireBearerAuth` + `requireEventMatchesJwt`

### GET `/api/v1/events/:event_id/awards/vote`

1往復で画面が描ける形を返す。

```jsonc
{
  "voting_open": true,
  "awards": [{ "id": "…", "name": "ベストブース賞", "description": "…", "color": "pink" }],
  "checked_booths": [
    { "id": "…", "name": "…", "description": "…", "display_code": "A-12", "category_id": null }
  ],
  "votes": { "<award_id>": "<booth_id>" }   // 未投票の賞はキーごと出さない
}
```

- `checked_booths` は `check_ins` から引く（フロントに計算させない）。`is_active = 0` のブースは除外
- 各行は `GET /v1/booths` の1行と同じ形（frontend の `mapV1Booth` を流用可）。**`manual_code` は含めない**（issue #121）
- `votes` のキーは `award_id`（賞名をキーにしない）

### POST `/api/v1/events/:event_id/awards/vote`

**全賞ぶんをまとめて1回で送る**（1賞ずつの API にしない）。

```jsonc
{ "votes": { "<award_id>": "<booth_id>", "<award_id2>": null } }   // null は取り消し
```

- **検証は全件まとめて行い、1件でも不正なら何も保存しない**（部分適用しない）
- 応答は GET と同じ形（保存後の状態）

| 条件 | 返す |
|---|---|
| `is_open = false` | 409 `VOTING_CLOSED` |
| `booth_id` がその参加者のチェックイン済みブースでない | 403 `NOT_CHECKED_IN`（`award_id` を message に含める） |
| ブースが `is_active = 0` | 403 `NOT_CHECKED_IN` と同じ（`checked_booths` に出てこない） |
| `award_id` がそのイベントの賞でない | 404 `NOT_FOUND` |
| 既に同じ賞へ投票済み | **上書き**（エラーにしない。`ON DUPLICATE KEY UPDATE`） |

## 運営向け

`preHandler`: `requireStaff`（閲覧）/ `requireManager`（変更）＋ `requireEventMatchesJwt`

| メソッド | パス | 権限 |
|---|---|---|
| GET | `/api/v1/admin/events/:event_id/awards` | staff。賞一覧＋票数（`vote_count`） |
| POST | `/api/v1/admin/events/:event_id/awards` | manager |
| PATCH | `/api/v1/admin/events/:event_id/awards/:award_id` | manager（name/description/color/sort_order） |
| DELETE | `/api/v1/admin/events/:event_id/awards/:award_id` | manager（`deleted_votes` を返す。投票は FK CASCADE で消える） |
| PATCH | `/api/v1/admin/events/:event_id/awards/voting` | manager（`{ is_open }`。監査ログ `award.voting.update`） |
| GET | `/api/v1/admin/events/:event_id/awards/:award_id/tally` | staff。ブース別票数（降順） |

- **集計は `users.role = 'participant'`（または NULL）で絞る。** スタッフ・出展者の試し投票は数えない
- 追加・編集・削除・開閉は監査ログに残す（`award.create` / `award.update` / `award.delete` / `award.voting.update`）
- **同数の順位付けはサーバーでしない。** 票数をそのまま返す

### tally 応答

```jsonc
{
  "award": { "id": "…", "name": "…" },
  "total_votes": 87,
  "booths": [{ "booth_id": "…", "booth_name": "…", "votes": 23 }]   // 降順・同数はそのまま
}
```

## 起きてはいけないこと

- チェックイン済み判定をフロントだけで行うこと（直接 POST で回避できる）
- 集計にスタッフ・出展者の票が混ざること
- 賞名をキーに投票を保存すること（名前の修正で票が消える。`award_id` で持つ）
- 投票を既定で開けておくこと（`is_open` の既定は `false`）
