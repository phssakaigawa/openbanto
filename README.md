# 🌸 OpenBanto

**Slackで空気を読み、必要な時だけ発言し、頼まれた仕事は最後までやり切る AI 同僚。**

「最後までやって」と言えば自律で動き続け、進捗は Slack の Canvas にライブ表示。
**エンジンは既定で [IBM Bob](https://bob.ibm.com/)（bobshell）** — 計画・設計・実装・テスト・
デプロイ・運用まで工程ごとにエージェントを持つ IBM の AI 開発パートナーを"裏方"に、
Slack の表を仕切る **AI 番頭**として常駐します。**Slackファースト・日本語ファースト**。
（エンジンは設定で claude / codex / gemini にも切替可能）

<p align="center">
  <img src="assets/ryoko-avatar.jpeg" alt="Banto" width="240" />
</p>

<p align="center">
  <img src="assets/jinn-showcase.gif" alt="OpenBanto Web Dashboard" width="800" />
</p>

> 🪶 **OpenBanto は [OpenRyoko](https://github.com/rsensui2/OpenRyoko)（MIT License）のフォーク**で、LLMエンジンに **IBM Bob（bobshell）** を採用した派生版です。OpenRyoko は [Jinn](https://github.com/hristo2612/jinn)（MIT License, by Hristo Stoyanov）の AI 組織・cron・Web ダッシュボードといった土台レイヤーを継承しつつ、Slack 上での**振る舞い**（空気読み・自律完遂・状態可視化）を大きく前進させた設計です。完全な帰属表示は [`NOTICE`](./NOTICE) を参照。
>
> ℹ️ OpenBanto は独立した OSS であり、**IBM 公式プロジェクトではありません**（"IBM" / "Bob" は IBM の商標）。

---

## 💡 OpenBantoが解く問題

社内 Slack に AI を住まわせると、すぐ3つの壁にぶつかります：

1. **「うざい」問題** — 雑談に割り込んでくる、誰宛か分からない発言に毎回反応する
2. **「中途半端」問題** — 1ターンで返事して止まる。長い作業の途中でユーザーが「続けて」「次は？」を投げ続けないといけない
3. **「見えない」問題** — 何が動いてるのか、何が詰まってるのか、Slack の会話ログを遡らないと分からない

OpenBanto はこの3つを**Slack側のメカニズムごと用意**して解決します：

| 問題 | OpenBanto の解 | 実装 |
|---|---|---|
| ① うざい | **空気読みトリアージ** — メッセージ毎に Haiku が silent/react/reply を判定。確信度60%未満は黙る | `slack/triage.ts` |
| ② 中途半端 | **エンジンの自律実行**（既定 IBM Bob のエージェント実行が複数ステップを完遂）。Claude Code エンジン時は自然言語 `/goal` で Stop hook を起動。各ターンの応答が個別 Slack メッセージで届く | `slack/goal-extractor.ts` / `engines/` |
| ③ 見えない | **Agents View Canvas** — running/waiting/errored/idle の全セッションを Slack チャンネルのタブとして30秒毎ライブ同期 | `slack/agents-canvas.ts` |

---

## ⚡ 30秒で始める

```bash
# 1) 既定エンジン IBM Bob を入れて認証（公式インストーラ）
curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash   # Node.js 22+
export BOB_API_KEY=...        # bob admin console で発行した API キー

# 2) OpenBanto 本体
npm install -g openbanto
openbanto setup
openbanto start
```

ブラウザで [http://localhost:7777](http://localhost:7777) → Settings → Slack に Bot Token を貼って保存。

> 💡 エンジンは差し替え可能です。**既定は IBM Bob**（`BOB_API_KEY` で認証）。
> claude / codex / gemini を使いたい場合は各 CLI を入れて `engines.default` を変更してください
> （Claude Code の `/goal` 自律完遂など、一部はそのエンジン固有の機能です）。

---

## 🌸 OpenBanto 独自の差別化

[Jinn](https://github.com/hristo2612/jinn) からは「常駐デーモン + マルチエンジン + AI組織 + Webダッシュボード + Cron + Skills + MCP」の枠を継承していますが、**Slack 上で AI同僚として実用に耐える挙動**は OpenBanto のためにフルに作り直しました。

### Slack 振る舞い系（全て OpenBanto 独自）

- 🌸 **空気読みトリアージ** — Haiku で `silent / react / reply` を判定。雑談・横の会話には介入しない保守的設計
- 🎯 **自然言語 `/goal`** — 「最後までやって」「完成するまで止まらないで」「終わったら教えて」等の意図を Haiku が拾い、Claude Code の Stop hook を起動
- 🖼️ **Agents View Canvas** — 全 Banto セッションを Slack の Canvas タブにライブ同期。設定 UI から channel picker でワンクリック有効化
- 💬 **ターン毎の個別投稿** — `/goal` で多ターン回した時、Claude の各ターンの応答が個別の Slack メッセージとして到着（進捗が見える）
- 👤 **発言者認識** — Slack ID から display name を解決し、operator と他者を system prompt 上で明示区別
- 🧵 **DM-equivalent 検出** — チャンネル内でも「ボット + 自分だけの会話」を検出して triage を skip、自然な対話を実現
- 📡 **Telegram コネクタ** — Jinn には無い 4 つ目のコネクタ

### エンジン / コスト最適化系（全て OpenBanto 独自）

- 💸 **Interactive PTY エンジン** — Claude を「対話モード」で PTY 起動（`cc_entrypoint=cli`）。2026/6/15 の Claude 改定後も自動化を**通常のサブスク利用枠**で動かし、Agent SDK クレジットの消費・追加課金を回避（オプトイン。SSH 実行は `claude -p` に自動フォールバック、ターンタイムアウト等で堅牢化）
- 📊 **コンテキストメーター** — codex / claude 両エンジンで直近ターンの入力コンテキスト量を計測・可視化。コンテキスト枯渇の予兆が一目で分かる
- 🖥️ **ライブ xterm CLI ビュー** — ダッシュボードで Claude の PTY セッションをそのままターミナル表示（`/ws/pty`、Origin/host ガード付き）
- ⚙️ **`ryoko config interactive` + setup/update プロンプト** — CLI でも Web UI でも interactive を切替。更新時に未設定なら対話で案内

### セキュリティ / 運用系（全て OpenBanto 独自）

- 🔒 **Loopback Host header guard + 限定 CORS** — DNS rebinding 対策。`gateway.host = 127.0.0.1` デフォルトで安全
- 🌐 **会話型オンボーディング** — Banto 自身が新規ユーザーに名前・役割・好みを聞いて `~/.openbanto/knowledge/` に保存
- ✨ **Onboarding ウィザード** — Web UI 初回起動時に Slack 機能（`/goal` / Canvas / triage）を視覚的に紹介
- 💡 **Inline discovery hint** — Slack tokens 設定済みで Canvas 未有効なら設定画面で気づかせる
- 🧠 **Persona / Memory レイヤー** — `ryoko update` で自動マイグレーションされる人格・記憶テンプレート
- 🏠 **`~/.openbanto` ホームディレクトリ** — `~/.jinn` からの自動マイグレーション付き、日本語ファースト

### Jinn から継承している土台（変えていない強み）

- 🔌 **マルチエンジン** — **IBM Bob（既定）** ／ Claude Code CLI ／ Codex ／ Gemini（`engines.default` で切替）
- 💬 **マルチコネクタ** — Slack / Discord / WhatsApp / Telegram
- 👥 **AI 組織システム** — 部門・階級・マネージャー・従業員・タスクボード
- 🌐 **Web ダッシュボード** — チャット / 組織図 / カンバン / コスト追跡 / cron 可視化
- ⏰ **Cron スケジューリング** — ホットリロード対応
- 🔄 **ホットリロード** — config / cron / org ファイルを再起動なしで反映
- 🛠️ **自己改変** — エージェントが自分の設定・スキル・組織を実行中に編集可能
- 📦 **スキルシステム** — Markdown プレイブックでエンジンが native に従う
- 🏢 **マルチインスタンス** — 複数の Banto を並列起動
- 🔗 **MCP 対応** — 任意の MCP サーバーに接続

---

## 💎 設計哲学

### 🧠 「バス、脳ではない」哲学

OpenBanto は独自のプロンプトエンジニアリング層を持ちません。**エンジン（既定 = IBM Bob）** が
ツール利用・ファイル編集・マルチステップ推論・MCP 連携を担当し、OpenBanto はそれを外の世界
（Slack、cron、WebUI、Canvas）に接続する"バス"に徹します。エンジンが進化すれば OpenBanto も
自動的に強くなります。エンジンは差し替え可能なので、用途に応じて **Bob / Claude Code / Codex /
Gemini** を選べます。

<details>
<summary>▶ Claude Code エンジンに切り替える場合（Max サブスク枠 / <code>/goal</code> 自律完遂）</summary>

Claude Code CLI を子プロセスとして起動すると Anthropic の公式クライアント扱いになり、Max
サブスクリプションの利用枠で動作します。2026/6/15 の Claude 改定後も、`engines.claude.interactive: true`
の **Interactive PTY** エンジンにすれば通常サブスク枠を維持できます（SSH 実行は headless `claude -p`
に自動フォールバック）。「最後までやって」を検出して自律完遂する `/goal` の Stop hook も Claude Code
固有の機能です。詳細は設定の `engines.claude.*` を参照してください。
</details>

### 🌸 空気読みの判断フロー

```
受信メッセージ
  ├─ DM？               ──→ 常に返信
  ├─ @メンション？       ──→ 常に返信
  ├─ DM相当の会話？      ──→ 常に返信（一度engage済み + 1ユーザーだけの会話）
  └─ グレーゾーン        ──→ Haiku でトリアージ
                             ├─ silent → 何もしない
                             ├─ react  → 絵文字スタンプだけ付ける
                             └─ reply  → 本エンジンで返信
```

判定基準（デフォルトプロンプトより）:
- 明らかに自分宛 → reply
- 自分の専門領域で役に立てる → reply
- 単なる同意・感謝 → react（絵文字のみ）
- それ以外 → silent（雑談には絶対に割り込まない）

確信度 60% 未満なら silent に倒す保守的設計です。

## 🚀 クイックスタート

### npm で入れる（推奨）

```bash
npm install -g openbanto
ryoko setup
ryoko start
```

アップデートは `ryoko update`。稼働中のゲートウェイをそのまま新コードに載せ替えたい場合は `ryoko update --restart` を使うと、更新・マイグレーション後に自動で再起動します（systemd ユニット → フォークデーモンの順に検出。systemd ユニット名は `--service <name>` か環境変数 `RYOKO_SERVICE` で上書き可、既定は `openbanto`）。

### ソースから入れる（開発・改造向け）

```bash
git clone https://github.com/phssakaigawa/openbanto.git
cd OpenBanto
pnpm install
pnpm build
npm install -g ./packages/jimmy

ryoko setup
ryoko start
```

ブラウザで [http://localhost:7777](http://localhost:7777) を開くとダッシュボードが表示されます。

## 🏗️ アーキテクチャ

```
                          +----------------+
                          |   ryoko CLI    |
                          +-------+--------+
                                  |
                          +-------v--------+
                          |   ゲートウェイ  |
                          |    デーモン     |
                          +--+--+--+--+---+
                             |  |  |  |
              +--------------+  |  |  +--------------+
              |                 |  |                  |
      +-------v-------+ +------v------+  +-----------v---+
      |    エンジン    | |  コネクタ    |  |    Web UI     |
      |Claude|Codex|Gem| | Slack|WA|DC |  | localhost:7777|
      +----------------+ +-------------+  +---------------+
              |                 |
      +-------v-------+ +------v------+
      |     Cron      | |   組織       |
      | スケジューラ    | |  システム     |
      +---------------+ +-------------+
```

CLI がゲートウェイデーモンにコマンドを送信。デーモンがAIエンジンへ作業を振り分け、コネクタ統合を管理し、cron ジョブを実行し、Web ダッシュボードを配信します。

## ⚙️ 設定

OpenBantoは `~/.openbanto/config.yaml` から設定を読み込みます（`~/.jinn/` が既存の場合、初回起動時に自動マイグレーション）。

```yaml
gateway:
  port: 7777

engines:
  default: bob             # 既定は IBM Bob。claude / codex / gemini に切替可
  bob:
    bin: bob               # 見つからない場合は絶対パス（例: ~/.npm-global/bin/bob）
    # モデルは Bob の team / API キーに紐づくため指定不要。認証は BOB_API_KEY 環境変数で渡す
  claude:
    bin: claude
    model: claude-opus-5
    interactive: false     # true で対話モード(PTY)。/goal 等の自律完遂は Claude Code 固有
  codex:
    bin: codex
    model: gpt-5.6-sol

connectors:
  slack:
    app_token: xapp-...
    bot_token: xoxb-...
    # 決定的な応答ゲート（トリアージの前段で評価。省略時は全メッセージに応答）
    respondTo:
      im: always            # DM: メンション不要で常に応答
      mpim: mention         # グループDM: @メンション時のみ
      channel: mention      # チャンネル: @メンション時のみ
      engagedThreads: true  # botが参加済みのスレッド内は再メンション不要（デフォルト true）
    # 空気読みトリアージ（メンションなしメッセージへの過剰反応を抑制）
    triage:
      enabled: true
      model: claude-haiku-4-5
      timeoutMs: 20000
      threadContextLimit: 10

cron:
  jobs:
    - name: daily-review
      schedule: "0 9 * * *"
      task: "PRをレビューして要約を投稿"

portal:
  portalName: Banto
  operatorName: 亮介
  language: Japanese

org:
  agents:
    - name: reviewer
      role: code-review
```

## 📁 プロジェクト構成

```
OpenBanto/
  packages/
    jimmy/          # ゲートウェイデーモン + CLI（パッケージ名: openbanto）
    web/            # Web ダッシュボード（パッケージ名: @openbanto/web）
  turbo.json
  pnpm-workspace.yaml
```

## 🧑‍💻 開発

```bash
git clone https://github.com/phssakaigawa/openbanto.git
cd OpenBanto
pnpm install
pnpm setup   # 一回限り: 全パッケージビルド + ~/.openbanto 作成
pnpm dev     # ゲートウェイ + Next.js dev サーバーをホットリロードで起動
```

[http://localhost:3000](http://localhost:3000) で Web ダッシュボードが開けます。

> **前提条件:** Node.js 22+、pnpm 10+、そして使うエンジンの CLI。既定は **IBM Bob**（`curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash` ＋ `BOB_API_KEY`）。claude / codex / gemini を使う場合は各 CLI を導入。

### 主要スクリプト

| コマンド | 説明 |
| --- | --- |
| `pnpm setup` | 全パッケージビルド + `~/.openbanto` 初期化（一回限り） |
| `pnpm dev` | ゲートウェイ（`:7777`）と Next.js dev サーバー（`:3000`）をホットリロードで起動 |
| `pnpm start` | クリーンビルド後にゲートウェイを `:7777` で起動 |
| `pnpm stop` | 稼働中のゲートウェイデーモンを停止 |
| `pnpm status` | ゲートウェイの稼働状態を確認 |
| `pnpm build` | 全パッケージをビルド |
| `pnpm typecheck` | TypeScript 型チェックを実行 |
| `pnpm lint` | 全パッケージを lint |
| `pnpm clean` | ビルド成果物を削除 |

## 🖥️ Linux サーバーで常駐させる（systemd）

VPS等で 24/7 稼働させたい場合、`scripts/systemd/` に systemd unit テンプレートと
インストーラを用意しています。これを使えば「`spawn claude ENOENT`」「rootだとClaude
CLIに弾かれる」「クラッシュ後に手動で立ち上げ直し」といったお決まりの落とし穴を
回避できます。

```bash
# 1. 専用ユーザーを作成（rootで動かさない）
sudo useradd -m -s /bin/bash ryoko

# 2. その ryoko ユーザーで Node 22+ と OpenBanto をインストール
sudo -u ryoko -i bash -lc '
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  source ~/.nvm/nvm.sh
  nvm install 22
  npm install -g openbanto @anthropic-ai/claude-code
  ryoko setup
'

# 3. systemd unit を /etc/systemd/system/ に配置して enable
sudo ./scripts/systemd/install.sh ryoko

# 4. ログ追跡
journalctl -u openbanto -f
```

`install.sh` は対象ユーザーの PATH（nvm の Node ディレクトリ含む）を自動検出して
unit ファイルに焼き込みます。手動で `openbanto.service` をコピーする場合は、
テンプレート先頭のコメント（User / WorkingDirectory / Environment=PATH=… /
ExecStart）を必ず編集してください。

常駐運用ではアップデートと再起動を `ryoko update --restart` の1コマンドで完結できます。
この unit（`openbanto`）を自動検出して `systemctl restart` を実行します（直接の権限が無い場合は
`sudo -n` を試行）。ユニット名が異なる場合は `--service <name>` か環境変数 `RYOKO_SERVICE` で指定してください。

> **rootで動かしたい場合**: 非推奨ですが、OpenBanto が `IS_SANDBOX=1` を自動付与
> するので Claude CLI の root 拒否はバイパスされます。それでも専用ユーザー運用を強く推奨します。

## ⚙️ Web UI からの設定変更

ダッシュボードの Settings 画面で Slack トークン等を保存すると、`~/.openbanto/config.yaml`
が更新されたあと自動でコネクタが再接続されます（v0.9.5 以降）。デーモン再起動は
不要です。手動で再接続したい場合は `POST /api/connectors/reload` を叩けます。

Settings → エンジン設定 には **「インタラクティブPTY（Max定額）」トグル** もあり、
`engines.claude.interactive` を切替できます（6/15 の Claude 改定対応）。エンジンの選択は
起動時に確定するため、このトグルの反映には**ゲートウェイの再起動が必要**です
（`ryoko update --restart` か `ryoko stop && ryoko start`）。

## 🎯 自然言語 `/goal` — 自律完遂タスク

Claude Code v2.1.139+ で追加された `/goal` コマンドを、Slackの自然な日本語/英語から
自動起動できます。

例えば DM や @メンションで：

> 5社の人事SaaSの料金/機能を比較した表をこのスレッドに投げて、**最後までやって**

と頼むと、OpenBanto は内部で Haiku を呼んで完了条件を一文に蒸留し、Claude Code への
プロンプトに `/goal X` を前置します。Claude は `/goal` の Stop hook を立て、**条件が
満たされるまで複数ターンに渡って自律的に作業**を続けます。各ターンの応答はそれぞれ
独立した Slack メッセージとして投稿されるので、進捗が見える形で届きます。

トリガーは決定論的なフレーズ（「最後まで」「止まらないで」「完成するまで」「終わったら
教えて」「keep going」「until done」等）に加え、文中に **埋め込まれた停止条件**
（「完了と書いたら止まる」「Xになるまで」「別々のターンで」等）にも反応します。
意味判定は Haiku が行うので、対応フレーズを覚える必要はありません。

> 💡 Claude Code は **v2.1.139 以降が必須** です（古いバージョンだと `/goal isn't available
> in this environment` になります）。`npm install -g @anthropic-ai/claude-code@latest`
> で最新化してください。

## 🖼️ Agents View Canvas — Slack でいつでも状況把握

設定で有効化すると、Banto は指定した Slack チャンネルに **「Banto Agents View」**
というタブ付き Canvas を自動作成し、現在動いている全セッションを30秒ごとに更新
します。Running / Waiting / Errored / Interrupted / Idle のグループに分かれて、
チャンネル上部のタブから即座に「いま何が走っているか」が把握できます。

### 有効化手順

1. **Slack App に scope を追加** — Settings ページの「Slack App Manifest」ブロックを
   コピーして自分の Slack App に貼り直し、Reinstall to Workspace を実行。これで
   `canvases:write` / `canvases:read` を含む必要 scope がすべて揃います
2. **Settings → Slack → Agents View Canvas** で：
   - 「有効化」をON
   - 「表示先チャンネル」のドロップダウンから対象チャンネル選択（Bot が member の
     channel のみ表示されます）
   - 必要に応じてタイトル・更新間隔・表示件数を調整
3. 保存すると30秒以内に指定チャンネルに Canvas が出現します

設定はホットリロード対応なので、デーモン再起動は不要です。

## 🔒 セキュリティ運用上の注意

OpenBanto は **個人マシン or 信頼境界内の VPS で 1 人 / 1 チームが使う前提**で
設計されています。本番運用する場合は以下を必ず守ってください：

- **`gateway.host` はデフォルト `127.0.0.1` のままにする**。外部公開する場合は必ず
  前段に **認証付きリバースプロキシ**（Tailscale Funnel + nginx basic auth、Cloudflare
  Access、Caddy with mTLS 等）を置く。daemon 自体は API 認証を持たない。
- **`connectors.slack.allowFrom` を必ず設定する**。空欄だとワークスペース全員が
  Banto を駆動でき、`/goal` の自然言語起動と組み合わさると秘密情報の流出経路に
  なり得る。trusted user の Slack ID をホワイトリストで明示すること。
- **Slack Bot の権限はそのまま Banto の権限**。Bot に `chat:write` `files:read` 等が
  付与されている以上、Slack の任意ユーザが promptインジェクション経由で Banto に
  これらを使わせる可能性は理論上残る。`allowFrom` の絞り込みが第一防御線。
- **Loopback Host header guard / 限定 CORS** を v2026.5.13 から有効化。`gateway.host`
  が `127.0.0.1` の時は loopback origin 以外からの API 呼び出しを 421 で拒否する。
  これにより DNS rebinding によるローカルブラウザ経由の attack をブロック。

## 🔗 Jinn からの移行

既に `~/.jinn/` で Jinn を運用している場合、OpenBanto は初回起動時に自動でディレクトリを `~/.openbanto/` にリネームします。トークン・セッション履歴・スキル・組織ファイルはすべてそのまま引き継がれます。

環境変数で古い設定を尊重することもできます：

- `JINN_HOME` — 指定パスをホームとして使用（後方互換）
- `JINN_INSTANCE` — インスタンス名指定（後方互換）
- `RYOKO_HOME` / `RYOKO_INSTANCE` — 新推奨

## 📄 ライセンス

[MIT](LICENSE)

元の著作権表記（Jimmy AI Contributors / Hristo Stoyanov）は `LICENSE` ファイルに保持されています。OpenBanto の追加変更も同じく MIT ライセンスで提供されます。

## 🙏 謝辞

- **デーモン・組織・cron・Webダッシュボード・skills・MCP** といった土台レイヤーは [Jinn](https://github.com/hristo2612/jinn) by Hristo Stoyanov のコードを継承しています。素晴らしい基盤を公開してくれた Hristo 氏に感謝します
- Web ダッシュボードの UI コンポーネントは [ClawPort UI](https://github.com/JohnRiceML/clawport-ui) by John Rice を基礎にしています
- `/goal` 自然言語化・Slack Canvas 同期・空気読みトリアージ等 **Slack 振る舞い系の機能**は OpenBanto 独自実装で、上流に汎用化できる部分は Jinn に PR を送る方針です

## 🤝 コントリビュート

本リポジトリは現在、個人利用に合わせた日本語ファーストの実験的派生版です。上流 Jinn に還元できる汎用的な改善は積極的に PR を送る方針です。
