# 0005. 積み重ねた PR は上から順にマージし、取り残しを CI で検出する

- 日付: 2026-08-28
- ステータス: 提案

## コンテキスト

2026-08-26 に、ビンゴ動的段階解放の実装を 3 段重ね（stacked）の PR で進めた。

```
develop
  └─ feat/bingo-unlock-1-schema        … PR #81 (base: develop)
       └─ feat/bingo-unlock-2-api-tests … PR #79 (base: feat/bingo-unlock-1-schema)
            └─ docs/bingo-unlock-3-documentation … PR #80 (base: feat/bingo-unlock-2-api-tests)
```

この 3 本を**下から順に**マージしたため、上位 2 本の内容が `develop` に届かなかった。

### 実際の時系列（JST）

| 時刻 | 操作 | 生成コミット |
|---|---|---|
| 08-26 21:08:19 | **#81** `bingo-unlock-1-schema` → `develop` | `ab10fe0` |
| 08-26 21:44:12 | #79 `bingo-unlock-2-api-tests` → `bingo-unlock-1-schema` | `63dbf2a` |
| 08-26 21:44:26 | #80 `bingo-unlock-3-documentation` → `bingo-unlock-2-api-tests` | `fb14066` |
| 08-27 01:33:37 | 手動で `origin/feat/bingo-unlock-1-schema` を `develop` へ再マージ | `4e7b451` |

`#81` が最初にマージされた時点で、`feat/bingo-unlock-1-schema` の先端は `6e2dd4a` であり、
`ab10fe0` の第二親も `6e2dd4a` である。**`#81` のマージ自体は当時の先端を正しく取り込んでいる。**

問題は、その 36 分後に `#79` と `#80` が**既に `develop` へマージ済みのブランチへ**マージされたことである。
`develop` から見ると、この 2 本は行き場を失った。

08-27 01:33 の手動再マージ（`4e7b451`）で `#79` の内容は回収されたが、
`#80` は 1 段上の `feat/bingo-unlock-2-api-tests` に載っていたため回収されなかった。

### 被害

| 取り残し | 失われたもの | 発覚 |
|---|---|---|
| `#79` の内容（一時的） | `src/lib/bingo/*.ts` のロジック刷新 | 参加者のビンゴ盤と運営分析が **500**。手動再マージで復旧 |
| `#80` の内容（2026-08-28 まで継続） | `docs/reference/` など 5 コミット | 本 ADR の調査中に発見 |

`#80` の取り残しには誰も気づいておらず、2 日間放置された。
その間 `docs/reference/database.md` に書かれていた
「`recommendation_scores` は `card_unlock_events` から CASCADE で消える」が `develop` に無く、
同じ調査を一からやり直す無駄が発生した。

### 先行する分析の訂正

[docs/specs/migration-09-followup/README.md](../../specs/migration-09-followup/README.md) §2 は
原因を「マージ操作の前に `git fetch` していなかったため」とし、
`#79` が `#81` より前（08-25）にマージされたと記述している。**これは事実と異なる。**

- `#79` のマージは `#81` の **36 分後**であり、両者とも 08-26 である（「翌日」ではない）
- `#81` のマージ時点で `63dbf2a` はまだ存在しない（作成は 21:44:12）。
  したがって取り込み漏れではなく、**fetch の有無は無関係**である

原因は fetch 忘れではなく、**積み重ねた PR のマージ順序**である。
この区別は対策に直結する。GitHub の
*Require branches to be up to date before merging* は `#81` のマージを止めない
（`#81` の base である `develop` に対しては最新だったため）。**あの設定では防げない。**

## 決定

積み重ねた PR について、次の運用を採る。

### 1. マージは上から下へ

`#80` → `#79` → `#81` の順にマージする。上位の内容が下位ブランチに落ちてから、
最後に一番下のブランチを `develop` へマージする。こうすれば 1 回のマージで全段が `develop` に入る。

### 2. 下を先にマージしてしまった場合は、残りの base を `develop` に付け替える

順序を誤った場合、残った PR の base branch を `develop` へ変更する（GitHub の PR 画面で変更できる）。
ブランチへの追いマージで回収しようとすると、今回のように 1 段上を取りこぼす。

### 3. 取り残しを CI で検出する

「`develop` にマージ済みのブランチを base に持つ open な PR」と、
「`develop` から到達できないコミットを持つ、直近に更新されたリモートブランチ」を
定期的に検査し、見つかったら通知する。

検査自体は次の 1 行で足りる（ブランチごとに実行し、非空なら取り残し）。

```bash
git rev-list --count origin/develop..<branch>
```

**ブランチ保護そのものは本 ADR では決めない。** リポジトリ設定の変更を伴い、
運用コストとの兼ね合いがあるため、別途判断する。

## 結果・トレードオフ

- **利点**: 今回のような取り残しは、上から順にマージすれば構造的に起きない。
  順序を誤っても 3 の検査で当日中に気づける
- **欠点**: 上から順にマージすると、一番下の PR がマージされるまで `develop` に何も入らない。
  段数が多いほど統合が遅れる。急ぐ場合は 2 の付け替えで対応する
- **限界**: 3 の検査は「作業が終わったが放置されているブランチ」と
  「まだ作業中のブランチ」を区別できない。通知は警告どまりで、マージを止める性質のものではない
- **今回の対応**: `#80` の 5 コミットは
  `integration/2026-08-migration-09-followup` で `origin/feat/bingo-unlock-2-api-tests`
  をマージして回収済み（`d1ba03a`）

## 関連

- [docs/specs/migration-09-followup/README.md](../../specs/migration-09-followup/README.md) — 取り残しが引き起こした 500 の修正（§2 の原因分析は上記のとおり訂正が必要）
- [docs/rules/git.md](../../rules/git.md) — ブランチとマージの作法
