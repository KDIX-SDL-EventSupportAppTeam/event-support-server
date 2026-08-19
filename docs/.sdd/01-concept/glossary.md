# 用語の追加提案

`docs/ubiquitous-language.md` を正本とする。本機能で新たに必要になる語を以下に挙げる。**実装着手前にユビキタス言語へ反映すること。**

| 用語 | 英名 | 定義 |
|------|------|------|
| ビンゴカード | Bingo Card | 参加者1人・1イベントにつき1枚の 4x4=16マス。`bingo_cards` |
| マス | Cell | カードの1区画。`position` 0..15（行優先: row = pos/4, col = pos%4）。`bingo_cells` |
| 中央マス | Center Cell | `position` 5, 6, 9, 10 の中央2x2。`zone='CENTER'` |
| 外側マス | Outer Cell | 中央以外の12マス。`zone='OUTER'` |
| 段階解放 / 解放 | Unlock | 中央4マスが全て達成された時点で外側12マスにブースを確定し、参加者に開示すること |
| 参加ボーナス | Signup Bonus | サインアップ時に中央4マスのうち1マスを達成済みで配ること。`source='SIGNUP_BONUS'` |
| 後出し割当 | Deferred Assignment | 参加者が自分の意思で訪問したブースを、事後的に中央マスへ割り当てること。`source='FREE_VISIT'` |
| 推薦割当 | Recommended Assignment | 解放時に外側12マスへ推薦ブースを配置すること。`source='RECOMMEND'` |
| カード外訪問 | Off-Card Visit | カードのどのマスにも対応しないブースへのチェックイン。`check_ins.cell_id IS NULL` |
| ライン | Line | 4行 + 4列 + 2対角 = 全10通り |
| ガチャコイン | Gacha Coin | 1ライン成立につき1枚。**累計最大4枚**でクリップ |
| クールタイム | Cooldown | 連続チェックインの最短間隔。**既定 0 秒＝無効**（[D-5](decisions.md)） |
| 割当戦略 | Assignment Strategy | マスにブースを入れた根拠の識別子。`PURE` / `SERENDIPITY` / `RANDOM` / `FALLBACK_COVERAGE` 等。VARCHAR で持ち、値の追加でスキーマを壊さない |
| 蓄積量 | Global Checkin Count | 割当を行った時点でのイベント全体の累計チェックイン件数。**「データ量が推薦精度を規定するか」の検証に使う中心変数** |

## 既存語との関係

- 既存の「推薦 / Recommendation」（`recommendations` テーブル、`/recommendations` エンドポイント）は**別系統として残す**。本機能の割当根拠は `cell_assignment_logs` に記録し、`recommendations` テーブルは使わない。両者を混ぜないこと
- 既存の「チェックイン / Check-in」の定義は変えない。列の追加のみ
