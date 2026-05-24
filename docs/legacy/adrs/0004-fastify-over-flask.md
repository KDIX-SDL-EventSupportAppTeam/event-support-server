# ADR 0004 — バックエンドを Flask から Node.js + Fastify に全換装する

**日付:** 2026-05-13  
**ステータス:** 採用

## 背景

旧バックエンドは Python + Flask で実装されていたが、設計書（system-server.md §5）が定義するスタックは Node.js + Fastify（TypeScript）である。フロントエンドの React リプレイスが完了したタイミングでバックエンドも設計書の定義に合わせる。

## 決定

- `backend/` 以下の Flask コードを廃止し、Node.js + Fastify（TypeScript）で全面的に書き直す。
- 旧 Flask コードは git 履歴に残るが、ディレクトリは上書きして削除する。

## 理由

- 設計書の選定理由（非同期I/O・WebSocket・TypeScript型安全性）がそのまま成立する。
- フロントとバックでTypeScriptに統一でき、型定義の共有が将来的に容易になる。
- Flask 固有の機能（flask_mail 等）はいずれも要件未確定のため、移植コストを生じさせず廃止できるタイミングである。

## 影響

- Flask で実装されていたメール送信（登録確認・パスワードリセット）は要件確定後に Fastify + nodemailer 等で再実装する（ADR 0004 と同ブランチでは実装しない）。
- Python の pandas による Excel エクスポートは Google Sheets API による出力に置き換える（api.md §22 参照）。
- `backend/requirements.txt` は削除し、`backend/package.json` を新設する。
