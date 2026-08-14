# 職人コントラクト — 番頭ID伝播 + per-user 強制

番頭（banto / gateway）は、**その回の Slack（等）ユーザーの identity を、毎ターン
すべての MCP ツール（職人 / shokunin）へ自動注入**する。各職人は、この identity を
権威（authority）として受け取り、**永続 I/O をこのユーザー単位でスコープすることを
必須**とする。これにより、マルチユーザー番頭でも「calendar も ledger も議事録も、
全部その人単位」になる。

これは規約（contract）であり、番頭側の実装は `mcp/resolver.ts` の
`resolveMcpServers()`、参照実装（reference implementation）は組込みの
`mcp/knowledge-server.ts`。

---

## 番頭が渡す identity

番頭は、発話者の identity を **トランスポート別**に注入する。値があるものだけを
付与する（identity が無い＝cron/内部/後方互換のときは **何も注入しない**）。
番頭は以下の well-known キーについて**権威**であり、既存値を上書きする。ただし
静的な認証（`Authorization` 等の静的ヘッダ、ユーザ定義 env）は保持する。

### stdio 職人（`command`/`args`/`env`）→ `env` にマージ

| env キー | 意味 |
|---|---|
| `JINN_USER_ID` | 発話者のコネクタ native ID（Slack `U12345…`）。安定・一意。 |
| `JINN_USER_KEY` | ファイルシステム安全な user key（`userKey()`：SlackID 優先→表示名正規化→空なら `unknown`）。**スコープキーとして使うのはこれ**。 |
| `JINN_USER_NAME` | 発話者の表示名（`msg.user`）。表示用のみ。信頼された ID には使わない。 |
| `JINN_CONNECTOR` | コネクタ名（`slack` 等）。 |
| `JINN_CHANNEL` | チャンネル/会話 ID。 |

既存の `env` は保持され、上記キーだけ番頭が権威として上書きする。

### URL 職人（HTTP/SSE：`type`/`url`/`headers`）→ `headers` にマージ

| ヘッダ | 意味 |
|---|---|
| `X-Banto-User-Id` | = `JINN_USER_ID` |
| `X-Banto-User-Key` | = `JINN_USER_KEY`（**スコープキー**） |
| `X-Banto-User-Name` | = `JINN_USER_NAME`（表示用） |
| `X-Banto-Connector` | = `JINN_CONNECTOR` |
| `X-Banto-Channel` | = `JINN_CHANNEL` |

**静的な認証ヘッダ（`Authorization` 等）は保持**され、`X-Banto-*` だけ番頭が付与する。

適用対象は **browser / search / fetch / gateway / knowledge / custom の全職人**。
identity が無ければ注入しない（＝後方互換）。

---

## 職人側の必須事項

1. **永続 I/O は user id でスコープすること（必須）**。
   - stdio 職人：`JINN_USER_KEY` を読み、per-user のサブツリー / テーブル /
     カレンダー等に書く。`JINN_USER_ID`（native ID）を一意キーに使ってもよい。
   - HTTP 職人：**`X-Banto-User-Id`（および `X-Banto-User-Key`）を読む**。
     リクエスト元ユーザーをこの値で識別し、per-user にスコープする。
2. `JINN_USER_NAME` / `X-Banto-User-Name` は**表示専用**。認可・スコープキーに
   使わない（名前は一意でも安定でもない）。
3. identity が **無い**ときのフォールバック（cron・内部呼び出し）は、職人ごとに
   安全側で定義する（共有ルート、匿名バケット、または拒否）。
4. 番頭が渡す `X-Banto-*` / `JINN_USER_*` を、職人が外部にそのまま**再送しない**
   （下流 API の認可は職人自身の資格情報で行う）。

## 参照実装：knowledge 職人

組込みの `mcp/knowledge-server.ts`（`read/write/list_knowledge`）は、この規約の
参照実装：

- 起動 env に `JINN_USER_KEY` があれば、その職人の I/O を **`users/<JINN_USER_KEY>/`
  を既定ルート**に自動スコープする。`profile.md` → `users/<key>/profile.md`。
- 明示的に `shared/…` で始まるパスは `knowledge/shared/…`（組織共通の逃げ道）。
- `JINN_USER_KEY` 未設定時は従来どおり knowledge ルート相対。
- **トラバーサル防止は維持**：絶対パス / `..` / `~` / root 外へ脱出する symlink を
  拒否し、内部絶対パスをエラー・成功応答に晒さない。ユーザーサブツリーからも
  KNOWLEDGE_ROOT を脱出できない（hard guarantee は「root を超えない」）。
- ツール `description` に「あなたの I/O は現在のユーザーに自動スコープされます」を
  明記し、モデルが per-user を意識しなくても正しく動くようにしている。

## 命名・後方互換

- env プレフィックスは内部互換の `JINN_`（`shared/paths.ts` の `JINN_HOME` と同じ
  方針で、値だけリブランド・キー名は互換維持）。ヘッダは `X-Banto-`。
- identity が無いターンでは注入がゼロ＝**既存職人・既存挙動に影響なし**。
- 番頭側の注入点は `mcp/resolver.ts`（per-turn 解決）。config を触らずターン毎に
  再構築されるので、identity は常にその回の発話者を反映する。

関連：`docs/design/tools-mcp-wiring.md`（MCP 配線）、
`docs/design/per-user-knowledge.md`（per-user 知識モデル）、
`docs/upstream-port/BANTO-PORT-PLAN.md` §P。
