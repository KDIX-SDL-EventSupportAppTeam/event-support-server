# さくらDB プロキシ 操作コマンド集

さくらインターネット上のWebAPIプロキシ経由でMySQLを操作するためのコマンド集。  
ローカル開発・動作確認・デバッグ時に使用する。

---

## 前提条件

| 項目 | 値 |
|------|----|
| プロキシエンドポイント | `https://sutolab.sakura.ne.jp/bingo/query/index.php` |
| 認証キー | `.env` の `SAKURA_PROXY_KEY` を参照 |
| 通信方式 | `POST` のみ（GET は 404 を返す仕様） |

コマンド中の `<KEY>` は `.env` の `SAKURA_PROXY_KEY` の値に置き換えること。

```bash
# .env からキーを確認する
grep SAKURA_PROXY_KEY .env
```

---

## 1. 接続確認

### 認証なし → 401 が返ることを確認

```bash
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT 1","params":[]}'
```

期待値：`{"error":"Unauthorized"}`

---

### 認証あり → DB に繋がることを確認

```bash
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d '{"sql":"SELECT 1 AS ok","params":[]}'
```

期待値：`{"rows":[{"ok":"1"}],"affectedRows":0,"insertId":null}`

---

## 2. DB 状態確認スクリプト

### 全テーブルの件数サマリー

`~/db-status.sh` として保存して使う。

```bash
cat << 'EOF' > ~/db-status.sh
#!/bin/bash
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d @- << 'JSON' | python3 -c "
import sys, json
data = json.load(sys.stdin)
print('テーブル               件数')
print('-' * 30)
for r in data['rows']:
    print(f\"{r['tbl']:<25} {r['cnt']:>4} 件\")
"
{
  "sql": "SELECT 'events'            AS tbl, COUNT(*) AS cnt FROM events           UNION ALL SELECT 'categories',          COUNT(*) FROM categories          UNION ALL SELECT 'booths',             COUNT(*) FROM booths             UNION ALL SELECT 'booth_tags',         COUNT(*) FROM booth_tags         UNION ALL SELECT 'booth_ratings',      COUNT(*) FROM booth_ratings      UNION ALL SELECT 'users',              COUNT(*) FROM users              UNION ALL SELECT 'survey_questions',   COUNT(*) FROM survey_questions   UNION ALL SELECT 'user_survey_answers', COUNT(*) FROM user_survey_answers UNION ALL SELECT 'check_ins',          COUNT(*) FROM check_ins          UNION ALL SELECT 'recommendations',    COUNT(*) FROM recommendations",
  "params": []
}
JSON
EOF
chmod +x ~/db-status.sh
```

実行：

```bash
~/db-status.sh
```

出力例：

```
テーブル               件数
------------------------------
events                    1 件
categories                0 件
booths                    0 件
...
```

---

### 全テーブルの中身を一覧表示

`~/db-all.sh` として保存して使う。

```bash
cat << 'EOF' > ~/db-all.sh
#!/bin/bash

KEY="<KEY>"
URL="https://sutolab.sakura.ne.jp/bingo/query/index.php"

TABLES=(
  "events"
  "categories"
  "booths"
  "booth_tags"
  "users"
  "survey_questions"
  "user_survey_answers"
  "check_ins"
  "booth_ratings"
  "recommendations"
)

for TABLE in "${TABLES[@]}"; do
  RESULT=$(curl -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "X-Proxy-Key: $KEY" \
    -d "{\"sql\":\"SELECT * FROM \`$TABLE\`\",\"params\":[]}")

  COUNT=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['rows']))" 2>/dev/null)

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $TABLE  ($COUNT 件)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if [ "$COUNT" = "0" ]; then
    echo "  (空)"
  else
    echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
rows = data['rows']
if not rows:
    print('  (空)')
else:
    keys = list(rows[0].keys())
    widths = {k: max(len(k), max((len(str(r.get(k,'') or '')) for r in rows), default=0)) for k in keys}
    header = '  ' + '  '.join(k.ljust(widths[k]) for k in keys)
    sep    = '  ' + '  '.join('-' * widths[k] for k in keys)
    print(header)
    print(sep)
    for r in rows:
        val = lambda k: str(r.get(k,'') or '')[:40]
        print('  ' + '  '.join(val(k).ljust(widths[k]) for k in keys))
"
  fi
done

echo ""
EOF
chmod +x ~/db-all.sh
```

実行：

```bash
~/db-all.sh
```

---

### 特定テーブルだけ確認

```bash
# テーブル名を変えれば何でも見られる
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d '{"sql":"SELECT * FROM booths","params":[]}' | python3 -m json.tool
```

---

## 3. テストデータの投入と削除

動作確認用のテストデータを入れて確かめ、最後に削除するまでの一連の手順。  
`events → categories → booths` の順で追加し、逆順で削除する（外部キー制約のため）。

> **UUID について**  
> 以下のコマンドで3つ生成して使う。
> ```bash
> node -e "
> const { randomUUID } = require('crypto');
> console.log('EVENT_ID   :', randomUUID());
> console.log('CATEGORY_ID:', randomUUID());
> console.log('BOOTH_ID   :', randomUUID());
> "
> ```

---

### イベントを追加

```bash
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d '{
    "sql": "INSERT INTO events (id, name, date_start, date_end, venue) VALUES (?,?,?,?,?)",
    "params": [
      "<EVENT_ID>",
      "テストイベント",
      "2026-06-10 10:00:00",
      "2026-06-10 18:00:00",
      "テスト会場"
    ]
  }'
```

期待値：`{"rows":[],"affectedRows":1,"insertId":null}`

---

### カテゴリを追加

```bash
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d '{
    "sql": "INSERT INTO categories (id, event_id, name) VALUES (?,?,?)",
    "params": [
      "<CATEGORY_ID>",
      "<EVENT_ID>",
      "テストカテゴリ"
    ]
  }'
```

期待値：`{"rows":[],"affectedRows":1,"insertId":null}`

---

### ブースを追加

```bash
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d '{
    "sql": "INSERT INTO booths (id, event_id, name, description, category_id, manual_code) VALUES (?,?,?,?,?,?)",
    "params": [
      "<BOOTH_ID>",
      "<EVENT_ID>",
      "テストブース",
      "これはテスト用のブースです",
      "<CATEGORY_ID>",
      "TST001"
    ]
  }'
```

期待値：`{"rows":[],"affectedRows":1,"insertId":null}`

---

### 追加内容を確認（3テーブル結合）

```bash
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d '{
    "sql": "SELECT b.name AS booth, c.name AS category, e.name AS event FROM booths b JOIN categories c ON b.category_id = c.id JOIN events e ON b.event_id = e.id WHERE b.id = ?",
    "params": ["<BOOTH_ID>"]
  }' | python3 -m json.tool
```

---

### テストデータを削除（ブース → カテゴリ → イベントの順）

```bash
# ブース削除
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d '{"sql":"DELETE FROM booths WHERE id = ?","params":["<BOOTH_ID>"]}'

# カテゴリ削除
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d '{"sql":"DELETE FROM categories WHERE id = ?","params":["<CATEGORY_ID>"]}'

# イベント削除
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d '{"sql":"DELETE FROM events WHERE id = ?","params":["<EVENT_ID>"]}'
```

各コマンドの期待値：`{"rows":[],"affectedRows":1,"insertId":null}`

---

## 4. 任意の SQL を実行する

プロキシは SQL をそのまま実行するため、上記以外のクエリも同じ形式で送れる。

```bash
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d '{
    "sql": "ここに SQL を書く",
    "params": []
  }' | python3 -m json.tool
```

---

## 5. テーブル構造の確認

```bash
# booths テーブルのカラム一覧
curl -s -X POST https://sutolab.sakura.ne.jp/bingo/query/index.php \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Key: <KEY>" \
  -d '{"sql":"DESCRIBE booths","params":[]}' | python3 -m json.tool
```

`booths` の部分を変えれば他のテーブルにも使える。

---

## 5. booth_categories テーブル（サンプルデータ用）

サンプルデータ生成で使う `booth_categories` は、**さくらプロキシ経由の DDL（CREATE TABLE）が 500 になる**ことがあります。  
その場合は phpMyAdmin 等で DB に直接接続し、以下を **1 回だけ** 実行してください。

```sql
CREATE TABLE IF NOT EXISTS booth_categories (
  booth_id    CHAR(36) NOT NULL,
  category_id CHAR(36) NOT NULL,
  PRIMARY KEY (booth_id, category_id),
  FOREIGN KEY (booth_id)    REFERENCES booths(id)     ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB;
```

テーブルが無くてもサンプル生成は動作します（各ブースの `category_id` のみ使用。複数カテゴリ紐付けはスキップ）。

---

## 関連ドキュメント

- [docs/orders/README.md](../orders/README.md) — 作業指示・依頼メモ
- [docs/deploy/cloud-run.md](./cloud-run.md) — Cloud Run デプロイ手順
- [AGENTS.md](../../AGENTS.md) — 環境変数一覧
