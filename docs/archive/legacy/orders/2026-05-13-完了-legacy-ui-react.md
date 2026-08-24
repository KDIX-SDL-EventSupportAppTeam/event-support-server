# 完了: 旧 Vue 相当 UI と参加者機能の React 化（2026-05-13）

## 完了条件（当時）

- 旧ルート（`/home`, `/booth-list`, `/gachapon/*`, `/checkin`, `/schedule`, `/award-vote`, `/qa` 等）を維持したまま React 画面を実装する。
- データは `EventDataSource`（ブース・ビンゴ）と `ParticipantClient`（ガチャ・チェックイン・投票・静的コンテンツ）に分離し、`sample` / `api` で切替可能にする。
- 認証はモック可能とし、リロード後も `user` を復元できるようにする。

## 実施結果

- 上記を満たす実装を `frontend/` に反映済み（詳細は `frontend/AGENTS.md`）。
- 設計ドキュメント `docs/designs/frontend.md` はグリーンフィールド向け記述が残っているため、`designs/README.md` と ADR で実装との差分を明示した。

## 残課題（参考）

- 運営画面・登録フロー等はプレースホルダのまま。
- `frontend.md` のディレクトリ構成と完全には一致しない（付録に差分表あり）。
