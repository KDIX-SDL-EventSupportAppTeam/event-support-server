---
状態: 実装済み
最終更新: 2026-08-28
---

# マイグレーション 09 の追従漏れ修正

**目的。** マイグレーション `09_bingo_staged_unlock.sql` でスキーマを刷新した際に
追従できていないコードを直し、現在 500 を返している API を復旧する。

**この仕様に未決定の項目は残っていない。**
書かれていないことを推測で埋めるくらいなら、手を止めて確認すること。

## 決定事項（2026-08-27）

| 論点 | 決定 |
|---|---|
| 応答フィールドの形 | **変えない。** 名前も型も現行のまま、`recommendation_scores` から埋める。フロントは無改修で復旧する |
| `selected` の意味 | 「利用者が選んだ」→「システムが割り当てた」に**変わることを許容する。** 変更点は docs に必ず残す |
| `summary.algorithm` | `card_unlock_events.strategy` で埋める（上の「形を変えない」に従う） |
| 研究用の指標 | **今回やらない。** [serendipity-data.md](../bingo-dynamic-unlock/07-research-logging/serendipity-data.md) の「暫定の定義（未確定）」が固まってから**別 PR** |
| サンプル生成の推薦データ | **作らない。** 解放処理の副産物であり捏造にあたるため（§4-C）。サンプル投入時は推薦分析が 0 件表示になるが、エラーにはならない |
| 今回のゴール | **500 を止め、運営が当日使える状態に戻すこと**（最小復旧） |

## 0. まず読むもの

| 文書 | なぜ |
|---|---|
| [AGENTS.md](../../../AGENTS.md) | このリポジトリの作業指針。**最優先** |
| [docs/rules/git.md](../../rules/git.md) | ブランチ・コミット・PR の作法（**日本語で書く**） |
| [db/migrations/09_bingo_staged_unlock.sql](../../../db/migrations/09_bingo_staged_unlock.sql) | **今回の原因。スキーマの正本** |
| [bingo-dynamic-unlock/02-data-model/schema-changes.md](../bingo-dynamic-unlock/02-data-model/schema-changes.md) | 新スキーマの意図 |
| [bingo-dynamic-unlock/06-api/admin-api.md](../bingo-dynamic-unlock/06-api/admin-api.md) | **運営 API の新契約（§4 の正本）** |

## 1. 症状（2026-08-27 時点・実機で再現確認済み）

ローカル（`docker compose up -d mysql` + `npm run dev`、シード済み）で再現する。

| 操作 | 結果 |
|---|---|
| 参加者 `/home` を開く | 「サーバーエラーが発生しました」。ビンゴ盤が出ない |
| 運営 `/admin/menu` の**ブース分析** | 同上 |
| 運営 `/admin/menu` の**推薦分析** | 同上 |
| `npm run db:clear:event` | チェックイン履歴が消えない |
| `npm run db:clear:sample` | 同上 |

API のレスポンス本文:

```jsonc
// GET /api/v1/events/:id/bingo/card
{"statusCode":500,"code":"ER_BAD_FIELD_ERROR","message":"Unknown column 'status' in 'field list'"}

// GET /api/v1/admin/events/:id/analytics/booths
// GET /api/v1/admin/events/:id/analytics/recommendations
{"statusCode":500,"code":"ER_NO_SUCH_TABLE","message":"Table 'event_support.recommendations' doesn't exist"}
```

**フロントエンド側は正常。** 500 を受けて既定のエラー文言を出しているだけで、
`event-support-frontend` に原因は無い（調査済み）。

## 2. 根本原因

マイグレーション 09 は次の破壊的変更を行っている。

```sql
-- bingo_cards: status / unlocked_at を削除（D-8。段階はマスから導出する）
-- bingo_cells: state を is_revealed / is_achieved の2軸へ分解（D-9）
-- recommendations は既存データごと削除する（D-11）
DROP TABLE IF EXISTS recommendations;
```

ところが**コード側がこの変更に追従しきれていない。**

### なぜ develop が壊れたか（経緯）

**積み重ねた（stacked）3本の PR を、下から順にマージしたため。**

```
develop
  └─ feat/bingo-unlock-1-schema         … PR #81 (base: develop)
       └─ feat/bingo-unlock-2-api-tests  … PR #79 (base: feat/bingo-unlock-1-schema)
            └─ docs/bingo-unlock-3-documentation … PR #80 (base: feat/bingo-unlock-2-api-tests)
```

| PR | ブランチ | base | マージ時刻（JST） |
|---|---|---|---|
| #78 | `feat/bingo-unlock-1-schema-logic` | develop | **CLOSED（未マージ）** |
| **#81** | `feat/bingo-unlock-1-schema` | develop | **08-26 21:08:19** |
| #79 | `feat/bingo-unlock-2-api-tests` | `feat/bingo-unlock-1-schema` | 08-26 21:44:12 |
| #80 | `docs/bingo-unlock-3-documentation` | `feat/bingo-unlock-2-api-tests` | 08-26 21:44:26 |

一番下の `#81` が最初にマージされ、その **36 分後**に `#79` と `#80` が
**既に develop へマージ済みのブランチへ**マージされた。この2本は行き場を失い、
`db/` のスキーマ刷新だけが develop に入って `src/lib/bingo/*.ts` のロジック刷新が取り残された。

08-27 01:33 に `origin/feat/bingo-unlock-1-schema` を develop へ手動で再マージ（`4e7b451`）した
ことで `#79` の内容は回収されたが、**`#80` は1段上に載っていたため回収されず、
2026-08-28 まで取り残されたままだった**（本対応で回収済み）。

> ⚠️ **`git fetch` 忘れが原因ではない。**
> `#81` のマージコミット `ab10fe0` の第二親は `6e2dd4a` だが、これは
> **21:08 時点の `feat/bingo-unlock-1-schema` の正しい先端**である
> （`63dbf2a` は 21:44:12 まで存在しない）。`#81` のマージ自体に誤りは無い。
>
> ```bash
> git show -s --format=%ci 6e2dd4a   # 2026-08-25 17:00:12 +0900
> git show -s --format=%ci ab10fe0   # 2026-08-26 21:08:19 +0900  ← #81
> git show -s --format=%ci 63dbf2a   # 2026-08-26 21:44:12 +0900  ← #79（#81 より後）
> ```
>
> 原因は fetch の有無ではなく**マージ順序**である。この区別は対策に直結する
> （ブランチの最新性を強制しても `#81` は止まらない）。
> 詳細と再発防止は [ADR 0005](../../decisions/adrs/0005-stacked-pr-merge-order.md)。

## 3. 影響範囲

`recommendations`（削除済みテーブル）を触っているコード。

| ファイル | 行 | 壊れる操作 |
|---|---|---|
| `src/routes/v1/admin/analytics.ts` | 109, 441 | 運営のブース分析・推薦分析 |
| `src/lib/event-data/clear-all.ts` | 56 | イベントデータ全削除 |
| `src/lib/sample-data/clear.ts` | 54 | サンプル削除 |
| `src/lib/sample-data/generate.ts` | 279 | サンプル生成 |
| `tests/unit/organizer-event-data.test.ts` | — | 上記に追従が要る |

`bingo_cards.status` 等を触っているコードは §4-A のマージで解決する。

## 4. 作業の分け方

統合ブランチ `integration/2026-08-migration-09-followup` を切り、
そこから作業ブランチを生やして**統合ブランチへ PR を出す。**

```
integration/2026-08-migration-09-followup
  ├─ A. merge: origin/feat/bingo-unlock-1-schema   ← ビンゴ側（マージのみ）
  ├─ B. fix/analytics-recommendation-scores        ← 運営分析（形は変えない）
  └─ C. fix/event-data-clear-recommendations       ← 削除・生成スクリプト
```

**A → C → B の順を推奨。** B は仕様の判断待ちが混じるため最後に回す。

---

### A. ビンゴ側（既存ブランチのマージのみ・**新規実装は不要**）

`origin/feat/bingo-unlock-1-schema` に正しい実装が既に存在する。

```bash
git fetch origin
git switch -c integration/2026-08-migration-09-followup develop
git merge origin/feat/bingo-unlock-1-schema
npm test && npm run build
```

> ✅ **完了（2026-08-28）。** 08-27 01:33 の手動再マージ（`4e7b451`）で
> `origin/feat/bingo-unlock-1-schema` は既に develop の先祖になっており、
> 上記 `git merge` は "Already up to date" になる（`/bingo/card` は実測で 200）。
> **A で新たに行う作業は無い。**
>
> ただし同じ積み重ねの最上段 `#80`（`origin/feat/bingo-unlock-2-api-tests`）は
> **回収されていなかった**ため、本対応でマージした（`d1ba03a`）。§2 と ADR 0005 を参照。

`ensureCard.ts` は `is_revealed` / `is_achieved` ベースの実装に置き換わっている。

> ⚠️ **これは §4-B（運営分析）を直さない。** マージ後のブランチにも
> `analytics.ts:109,441` の `FROM recommendations` はそのまま残っている（確認済み）。

---

### B. 運営分析を `recommendation_scores` へ移す

作業ブランチ: `fix/analytics-recommendation-scores`

#### 新旧テーブルの対応

**この2つは行の意味が違う。機械的な置き換えはできない。**

| | 旧 `recommendations`（削除済み） | 新 `recommendation_scores` |
|---|---|---|
| 1行の意味 | 1回の推薦提示 | **候補ブース1件**（提示ごとに複数行） |
| ブース列 | `offered_booth_ids`（JSON配列） | `booth_id`（1件） |
| 採用 | `selected_booth_id`（**利用者が選んだ**） | `was_assigned`（**システムが割り当てた**） |
| 手法 | `algorithm` | **列が無い**。`card_unlock_events.strategy` を使う |
| イベント絞り込み | `event_id` 列あり | **`event_id` 列が無い。JOIN が要る** |

新スキーマ（`09_bingo_staged_unlock.sql`）:

```sql
CREATE TABLE recommendation_scores (
  id CHAR(36) PRIMARY KEY,
  unlock_event_id CHAR(36) NOT NULL,   -- → card_unlock_events.id
  user_id CHAR(36) NOT NULL,
  booth_id CHAR(36) NOT NULL,
  score DOUBLE NULL,
  rank_in_event SMALLINT NULL,
  was_assigned TINYINT(1) NOT NULL DEFAULT 0,
  interest_match ENUM('MATCH','PARTIAL','MISMATCH','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  attributes JSON NULL,
  reason_payload JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

イベントで絞る JOIN 経路は次のとおり。**`users.event_id` で代用しない**
（出展者・運営アカウントが混ざるため。[00-must-do.md](../bingo-dynamic-unlock/00-must-do.md) の
「分析から除外」を参照）。

```sql
FROM recommendation_scores rs
INNER JOIN card_unlock_events cue ON cue.id = rs.unlock_event_id
INNER JOIN bingo_cards        bc  ON bc.id  = cue.card_id
WHERE bc.event_id = ?
```

`card_unlock_events` には `phase` / `strategy` があり、フェーズ別集計に使える。

#### B-1. `/analytics/booths`

現在この 3 フィールドを返している（`analytics.ts:161-163`）。

```
recommendation_offered_count    ← offered_booth_ids から集計
recommendation_selected_count   ← selected_booth_id から集計
recommendation_acceptance_rate  ← selected / offered
```

**フィールド名も型も変えない。** 集計元だけを差し替える。

| フィールド | 新しい集計元 |
|---|---|
| `recommendation_offered_count` | そのブースが候補に挙がった行数（`COUNT(*)`） |
| `recommendation_selected_count` | `SUM(was_assigned)` |
| `recommendation_acceptance_rate` | 上記の比（既存の `rate()` をそのまま使う） |

`was_assigned` は `TINYINT(1)` なので `SUM()` の戻りが文字列になり得る。
**既存コードと同様に `Number(...) || 0` で正規化すること。**

> ⚠️ **`selected` の意味が変わる。**
> 旧: 利用者が提示の中から**選んだ** / 新: システムがマスに**割り当てた**。
> この変更は許容すると決めた（§決定事項）が、**必ず記録に残すこと。**
> - `analytics.ts` の該当箇所にコメントを入れる
> - `docs/reference/` に変更点を書く（[rules/documentation.md](../../rules/documentation.md)）
>
> 運営画面の「推薦採用 ○○%」という表示文言は**今回は変えない**
> （フロント無改修で復旧させるため）。文言の見直しは別途。

#### B-2. `/analytics/recommendations`

**今回は「500 を止めて運営が当日使える状態に戻す」ところまで。**
ここも B-1 と同じく**応答の形を変えない。**

| フィールド | 新しい集計元 |
|---|---|
| `summary.total_recommendations` | 対象イベントの `recommendation_scores` の行数 |
| `summary.selected_count` | `SUM(was_assigned)` |
| `summary.acceptance_rate` | 上記の比 |
| `summary.open_count` | `was_assigned = 0` の行数 |
| `summary.algorithm` | `card_unlock_events.strategy` の最頻値 |
| `by_booth` | ブース単位で上と同じ集計 |
| `transitions` / `conversion` | 推薦→チェックインの導線。`check_ins` との突き合わせ方は**新旧で変わらない**（`recommendation_scores.created_at` を推薦時刻として使う）|

##### 研究用の指標は今回やらない（別 PR）

[admin-api.md](../bingo-dynamic-unlock/06-api/admin-api.md) には次の改修が書かれている。

> - 推薦されたマスへの訪問率（フェーズ別・`interest_match` 別）
> - 推薦されたが訪問されなかった件数（分母）
> - カード外訪問の件数（対照群）

これらの詳細要件である
[serendipity-data.md](../bingo-dynamic-unlock/07-research-logging/serendipity-data.md) には
「## 暫定の定義（未確定）」の節が残っている。

**定義が固まっていないものは実装しない。** 定義の確定後に別 PR で対応する。
この PR では上表の「形を変えない復旧」だけを行い、
`phase` / `interest_match` を使った新指標には手を付けないこと。

---

### C. 削除・生成スクリプト（機械的）

作業ブランチ: `fix/event-data-clear-recommendations`

#### CASCADE で足りる（確認済み）

外部キーは次の通り連鎖しており、**`bingo_cards` を削除すれば
`card_unlock_events` も `recommendation_scores` も自動で消える。**

```
bingo_cards
  └─ card_unlock_events      (09_...sql:110  ON DELETE CASCADE)
       └─ recommendation_scores (09_...sql:128  ON DELETE CASCADE)
```

`clear-all.ts` は既に `DELETE FROM bingo_cards WHERE event_id = ?` を実行している。
**`recommendation_scores` を明示的に消す DELETE 文を足す必要は無い。**

| ファイル | 直し方 |
|---|---|
| `src/lib/event-data/clear-all.ts:56` | `DELETE FROM recommendations ...` の**行ごと削除する**（上記のとおり CASCADE で消えるため代替は不要）。あわせて戻り値の型 `EventDataClearResult.deleted.recommendations`（同ファイル `:6`）と `:79` の組み立て、呼び出し側（organizer ルート）を直す |
| `src/lib/sample-data/clear.ts:54` | 同上。行ごと削除でよい |
| `src/lib/sample-data/generate.ts:279` | **`recommendationRows` の組み立てごと削除する**（下記） |
| `tests/unit/organizer-event-data.test.ts` | 戻り値から `recommendations` が消えることに追従 |

> 💡 `clear-all.ts:56` は関数の先頭付近にある。ここで例外が出ると
> 後続の `check_ins` 削除まで到達しないため、
> 「チェックイン履歴が消えない」症状の原因はこれと考えられる。

#### サンプル生成では推薦データを作らない

`recommendation_scores` は**解放処理の副産物**であり、行を作るには
`card_unlock_events`（`card_id` / `pair_key` / `line_index` / `phase` /
`strategy` / `global_checkin_count`）を先に捏造する必要がある。
これは研究ログの偽造にあたり、最小復旧の範囲を超える。

**今回はサンプル生成で作らない。**

- 影響: サンプルデータ投入時、運営の**推薦分析は 0 件表示**になる
- **エラーにはならない**ので「500 を止める」ゴールは満たす
- 実データ（実際に解放が起きた DB）では正しく集計される

サンプルでも数字を出したくなったら、それは別 PR の課題とする。

## 5. フロントエンドへの波及

**無改修で復旧する。** 応答の形を変えないと決めたため（§決定事項）、
`event-support-frontend` 側の修正は不要。

ただし下表のフィールドに依存しているので、**形を崩していないことの確認には使う。**

| フロント側 | 依存フィールド |
|---|---|
| `src/shared/api/v1Admin.ts:259-261` | `recommendation_offered_count` / `_selected_count` / `_acceptance_rate` |
| `src/shared/api/v1Admin.ts:317-328` | `total_recommendations` / `acceptance_rate` / `open_count` / `algorithm` |
| `features/admin/windows/BoothAnalyticsWindow.tsx:83,139` | `recommendation_acceptance_rate`（表示・ソート） |
| `features/admin/windows/RecommendationAnalyticsWindow.tsx:45,65,73,81,89` | `summary.*` 一式 |

`acceptance_rate` は `number`、`recommendation_acceptance_rate` は `number | null`。
**null 許容の違いを崩さないこと**（フロントが `!= null` で分岐している）。

## 6. 完了の条件

- `grep -rn "FROM recommendations\|INTO recommendations" src` が **0 件**
- ローカルで次がすべて成功する（`docker compose up -d mysql` + シード済み）
  - 参加者 `/home` でビンゴ盤が出る
  - 運営 `/admin/menu` の 4 ウィンドウすべてがエラー無く描画される
  - `npm run db:clear:event` の後、`check_ins` が実際に 0 件になる
  - `npm run db:seed:sample` → `npm run db:clear:sample` が通る
- **フロントを一切変更していない**（変更が要るなら形を崩している）
- `npm test` と `npm run build` が通る
- **意味が変わった `selected`** について記録が残っている
  - `analytics.ts` の該当箇所にコメント
  - `docs/reference/` に変更点（[rules/documentation.md](../../rules/documentation.md)）
- 研究用の新指標（フェーズ別・`interest_match` 別）に**手を付けていない**

### 動作確認に使うアカウント

シード（`npm run db:seed`）済みのローカル DB での確認用。

| 用途 | メール | パスワード |
|---|---|---|
| 参加者 | `dev@example.com` | `password123` |
| 運営（manager） | `admin@example.com` | `password123` |

イベント ID は `20000000-0000-4000-8000-000000000001`。

## 7. 再発防止

[**ADR 0005: 積み重ねた PR は上から順にマージし、取り残しを CI で検出する**](../../decisions/adrs/0005-stacked-pr-merge-order.md)（ステータス: 提案）に記録した。

同じ原因の取り残しが**2件**起きている（`#79` の一時的な取り残しと、`#80` の2日間の放置）。
要点は次のとおり。

1. 積み重ねた PR は**上から順に**マージする（`#80` → `#79` → `#81`）
2. 下を先にマージしてしまったら、残りの PR の **base を `develop` に付け替える**
   （ブランチへの追いマージだと1段上を取りこぼす。今回まさにそれが起きた）
3. `git rev-list --count origin/develop..<branch>` で取り残しを検査して通知する

**`develop` のブランチ保護を有効にするかは ADR では決めていない**（リポジトリ設定の変更を伴うため別途判断）。
なお GitHub の *Require branches to be up to date before merging* は
**今回の事故を防げない**（`#81` は base である `develop` に対しては最新だった）。
