---
状態: 実装済み
最終更新: 2026-08-24
---

> **現状の事実を記録する文書。** 「これからどうするか」は [../specs/](../specs/README.md) を見ること。

# 認証・認可の仕組み

```
POST /api/v1/auth/login → JWT 発行（payload: { sub, event_id, display_name, role }）
POST /api/v1/organizer/auth/login → 主催者 JWT 発行（payload: { sub, scope: 'organizer' }）
        ↓
以降のリクエストに Authorization: Bearer <token> を付与
        ↓
requireBearerAuth         → トークンの署名・有効期限を検証
requireEventMatchesJwt    → URL の :event_id と JWT の event_id が一致するか検証
requireManager            → role: manager（旧 admin 含む）を要求
requireStaff              → role: manager または viewer を要求
requireOrganizer          → 主催者 JWT（scope: 'organizer'）を検証
```

`requireAdmin` は `requireManager` の後方互換エイリアス。  
ペイロードの詳細は [docs/ubiquitous-language.md](./docs/ubiquitous-language.md) § 認証・ユーザーを参照。

出展者（`role: 'exhibitor'`）の認可は JWT に依存せず、リクエストごとに `users.role` と `exhibitor_booths` を DB で確認する（`src/lib/exhibitor.ts`）。一括登録で既存参加者に後付けでロールを付与するケースがあり、発行済み JWT が古いままでも正しく判定するため。
