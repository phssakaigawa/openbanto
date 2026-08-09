# JINN (upstream) → OpenRyoko 移植設計書

本家 `hristo2612/jinn` の v0.11〜engine-sprint で入った機能を OpenRyoko に取り込むための設計書。
Codex がレビュー→実装まで完結できるよう、ファイル単位で移植手順・リスク・検証方法を記載する。

- 分岐点: `937eefd`（OpenRyoko 側 `feat/employee: sshHost`）
- 本家 HEAD: `upstream/main`（engine sprint マージ済み `ae00e0a` / `80b2759`）
- OpenRyoko の構成上の差: パッケージ名は `jimmy`（本家は `jinn` へリネーム済み）、Web は **Next.js**（本家は Vite + React Router へ移行済み）
  - → 本家の Web コンポーネントは**そのまま使えない**。ゲートウェイ/エンジン層（結合度が低い）を優先移植し、UI は Next.js 側で再実装する。

---

## ステータス一覧

| # | 機能 | 区分 | 状態 | 主担当 |
|---|------|------|------|--------|
| 1 | Slack リアクション承認フィックス (v0.17.1) | 即取り込み | ✅ 実装済み | Claude |
| 2 | コンテキストメーター (codex+claude / 永続化 / Next.js UI) | 即取り込み | ✅ 実装済み | Claude |
| 3 | Codex gpt-5.5 対応 | 価値高 | ✅ 既存（フォークに既にあり、model picker config のみ追補） | Codex |
| 4 | COO 静的ベース廃止 → CLAUDE.md/AGENTS.md 自動取り込み | 即取り込み | ⏳ 設計のみ | Codex |
| 5 | Web 双方向ファイル/画像添付 + 添付API + 不変キャッシュ (v0.16.0) | 価値高 | ⏳ 設計のみ | Codex |
| 6 | サブエージェントカード (live sub-agent cards) | 価値高 | ⏳ 設計のみ | Codex |
| 7 | Interactive Claude PTY エンジン（Max定額課金） | 即取り込み（最大価値） | ✅ Phase 1 実装済み（CLI xterm view は Phase 2 残） | Claude |

> #1, #2, #7(Phase1) は本ブランチ `feat/upstream-port-context-meter-slack-fix` で適用済み。
> #3〜#6 は本書の手順に沿って Codex が段階実装する。

### #7 Phase 1 実装内容（コミット 3b0e65e）
- 新規(self-contained 移植): `engines/{pty-lifecycle,pty-view-engine,sse-pty-proxy,claude-interactive}.ts`、`gateway/{hook-registry,hook-endpoint,gateway-info}.ts`、`shared/{claude-settings,skill-commands}.ts`、`assets/hook-relay.mjs`
- 配線: `api.ts` に loopback-only `/api/internal/hook` + ApiContext(hookRegistry/hookSecret)、`server.ts` でオプトイン登録 + gateway.json(port+secret) 書込 + シャットダウン dispose、`shared/types.ts` の StreamDelta に `context` 型 + `subAgent` 追加、`package.json` に node-pty(+onlyBuiltDependencies)
- オプトイン: `config.engines.claude.interactive`（default false = 従来の `claude -p`）。true 時のみ "claude" キーのエンジンを差し替え
- OpenRyoko独自: `sshHost` ターンは headless `claude -p` フォールバックへ委譲（ローカルPTYはリモート実行不可）。kill/isAlive/killAll も委譲
- テスト: 本家8本移植 + SSHフォールバック4本。計 432 green、tsc クリーン

### #7 Phase 2（実装済み — CLI xterm view）
PTY を Web ダッシュボードのライブ xterm ビューに接続。
- `gateway/pty-ws.ts`（`/ws/pty/:sessionId` WebSocket、scrollback replay + stdin/resize/viewing + lazy spawn）
- `gateway/server.ts`: `ptyWss` + `ptyViewEngines` map + `/ws/pty` upgrade（host/Origin ガード + decodeURIComponent try/catch + shutdown close）
- `gateway/api.ts`: `/api/status` に `engines.claude.interactive` を露出
- Next.js `cli-terminal.tsx`（xterm.js, inline page-visibility, iOS glyph fix, touch-scroll）+ `chat-pane.tsx` で `engine==='claude' && interactive` 時に live xterm、それ以外は poll-based transcript
- 依存: `@xterm/xterm` + `@xterm/addon-fit`、`next.config.ts` に `/ws/pty` dev rewrite
- Codex レビュー（CRITICAL: WS Origin/host ガード 他4件）反映済み

### #7 本番デプロイ状況（リモート SENSUI, systemd ryoko.service）
- **interactive:true で稼働中**（PID更新済み, gateway.json present）。グローバル `openryoko` を本番ソースビルド + `npm install -g .` で更新（公開npm publishは未実施=このサーバー限定、v2026.5.29へロールバック可）
- 実機検証: 制御ターン4秒完走 + **10分監視で組織的実トラフィックがバースト完走（timeout 0 / stuck 0）**。初回の1件ハングは再現不能=一過性(boot/recovery race)で、15分ターンタイムアウトの安全網を追加済み
- セキュリティ: /ws/pty の不正Origin拒否を本番で確認（`000`切断）
- ロールバック: `interactive:false` + 再起動で headless `claude -p` に即復帰（config.yaml.bak-pre-interactive 保全）

### 残課題（polish）
- interactive 経路の `lastContextTokens` / cost が transcript 復元由来で未populate のケースあり（Max定額なので cost=0 は正しい。context メーターのみ要調整）
- 0.0.0.0 運用時の WS Origin ポリシー（既存HTTP CORS方針と一貫、必要なら厳格化余地）

---

## 1. ✅ Slack リアクション承認フィックス（実装済み）

本家 `aec5972`。`packages/jimmy/src/connectors/slack/index.ts` の `reaction_added` ハンドラ。

- ガード判定を「リアクション対象メッセージの古さ」→「リアクションイベント自身の `event_ts`」へ変更。
  古いカードへの新規承認リアクションが boot-replay ガードで落ちる問題を解消。
- リアクション受信時に `:eyes:` を即時付与（受領確認）。

検証: `npx vitest run`（slack 関連テスト含む全 390 件 green）。

---

## 2. ✅ コンテキストメーター（実装済み）

「直近ターンの入力コンテキスト量（input + cache-read + cache-creation トークン）」を計測し、
セッションに永続化、Web に表示する。

### バックエンド（実装済み）
- `shared/types.ts`: `EngineResult.contextTokens?: number` / `Session.lastContextTokens: number | null`
- `engines/codex.ts`: `extractCodexContextTokens()`（`turn.completed` の `usage.input_tokens`）。
  run ループで `lastContextTokens` を追跡し全 `resolve()` に付与。
- `engines/claude.ts`: `extractContextTokens()`（result event の `usage`、無ければ `modelUsage` を合算）を
  `buildEngineResultFromResultEvent()` に組込み。
- `sessions/registry.ts`: `last_context_tokens` カラム追加（マイグレーション配列 + rowToSession + createSession 既定 + UpdateSessionFields + updateSession）。
- `sessions/manager.ts`: ターン完了時の終端 `updateSession()` に `lastContextTokens` を反映。
- `gateway/api.ts`: `serializeSession()` は `...session` スプレッドのため自動的に露出。

### フロントエンド（実装済み, Next.js）
- `web/src/lib/context-meter.ts`: 純関数（`formatContextTokens` / `contextWindowFor` / `contextFraction` / `contextLevel`）。
  モデル別コンテキスト窓を推定し、しきい値（70%警告 / 90%危険）で色分け。
- `web/src/components/chat/context-meter.tsx`: 細バー + トークン数バッジ。トークン未報告時は非表示。
- `web/src/components/chat/chat-pane.tsx`: QueuePanel 直前にバッジ描画 + `/status` 出力に `Context:` 行追加。

### 残課題（任意・改善）
- **ライブ更新**: 現状は `api.getSession()` 取得時点の値。SSE/WebSocket イベントに `contextTokens` を載せ、
  ターン進行中もリアルタイム更新したい場合は `events` ストリームへフィールド追加（本家 `sse-pty-proxy` 相当）。
- モデル別コンテキスト窓テーブル（`MODEL_WINDOWS`）の実値精査。

---

## 3. Codex gpt-5.5 対応（ほぼ完了）

フォークは既に `template/config.default.yaml` で codex 既定モデルを `gpt-5.5` に設定済み、
`codex.ts` も gpt-5.5 の interim-message 挙動に対応済み。

**残作業（Codex）**: 本家 `0c2e35e` の model picker エントリのみ追補。
```yaml
- { id: gpt-5.5, label: "GPT-5.5", supportsEffort: true, effortLevels: [low, medium, high, xhigh] }
```
- 対象: `packages/jimmy/template/config.default.yaml` の models リスト（存在すれば）。
- 注意: 本家は headless `claude -p` を削除したが、**OpenRyoko は `-p` を主力エンジンとして維持**するため、
  `0c2e35e` の `claude.ts` 削除部分は**取り込まない**（#7 の PTY 化が完了するまでは現行 `-p` を残す）。

---

## 4. COO 静的ベース廃止 → CLAUDE.md/AGENTS.md 自動取り込み

本家 `fe524a2`。`buildContext()` から固定の COO プロンプトを除去し、
`~/.jinn`（OpenRyoko では `~/.jinn` 相当の JINN_HOME）配下の `CLAUDE.md` / `AGENTS.md` を自動取込みに依存させる。

**対象ファイル**:
- `packages/jimmy/src/sessions/context.ts`（本家差分 -184 行 = 大幅スリム化）
- `packages/jimmy/src/cli/setup.ts`（セットアップ時のテンプレ生成調整）

**移植方針**:
1. OpenRyoko の `context.ts` には**ペルソナ/メモリ層**という独自拡張がある。本家の COO 除去をそのまま適用すると
   OpenRyoko 固有のペルソナ注入が壊れる恐れ → **全面置換ではなく差分マージ**。
2. 「静的 COO テキストの撤去」と「CLAUDE.md/AGENTS.md 自動 ingest の追加」だけを取り込み、
   ペルソナ/メモリ注入ロジックは温存する。
3. Codex はまず `git show fe524a2 -- packages/jinn/src/sessions/context.ts` で本家差分を読み、
   OpenRyoko の `context.ts` の現行 buildContext と突き合わせて、競合しない範囲で ingest 部分のみ移植する。

**リスク**: 中（OpenRyoko 独自のペルソナ層と密結合）。**検証**: `sessions` 関連テスト + 実セッションで system prompt を確認。

---

## 5. Web 双方向ファイル/画像添付 + 添付API + 不変キャッシュ (v0.16.0)

本家 `3d1861c` / `7947f91` / `0226e64`。**ゲートウェイ層は Next.js 非依存で移植可能**、UI のみ再実装。

**対象ファイル（バックエンド = そのまま移植可）**:
- `packages/jimmy/src/gateway/files.ts`（+357 行: 日付バケット保存 `~/.jinn/uploads/YYYY-MM-DD/<sessionId>/`、
  `GET /api/files/read`(5MB上限+バイナリ検出), 不変キャッシュ `Cache-Control: immutable`+ETag+304）
- `packages/jimmy/src/gateway/api.ts`（`POST /api/sessions/:id/attachments`: multipart/JSON対応）
- `packages/jimmy/src/gateway/server.ts`（ルーティング）
- `packages/jimmy/src/sessions/registry.ts`（添付メタの永続化カラム +6 行）
- `packages/jimmy/src/sessions/context.ts`（プロンプトへのファイルパス注入 +11 行）
- `packages/jimmy/src/shared/paths.ts`（uploads ディレクトリ +2 行）

**フロントエンド（Next.js 再実装が必要）**:
- ドラッグ&ドロップ/貼り付け UI（chat-pane には既に `droppedFiles` の受け口あり → 接続するだけ）
- インライン画像サムネ + ライトボックス、ファイルチップ（名前+サイズ）
- 本家の Vite コンポーネントは参照のみ。Next.js の既存 `file-attachment.tsx` を拡張。

**移植順**: ①gateway/files.ts と paths.ts → ②registry のカラム → ③api.ts/server.ts のルート →
④context.ts のパス注入 → ⑤Next.js UI 接続。

**リスク**: 中。**検証**: 添付 API への curl（multipart/JSON）、`GET /api/files/read` の 304 応答、UI で画像表示。

---

## 6. サブエージェントカード（live sub-agent cards）

本家 `940d389` + `9f0a52c`。Task サブエージェントの稼働を Web にライブ表示。
**前提として #7 の PTY/SSE 基盤（`sse-pty-proxy.ts`）に依存**するため、#7 の後に実施する。

**対象ファイル**:
- `packages/jimmy/src/engines/sse-pty-proxy.ts`（+250 行: tool-bearing リクエスト分類でサブエージェント検出）
- `packages/jimmy/src/engines/claude-interactive.ts`（+10 行: カード発火）
- `packages/jimmy/src/shared/types.ts`（+6 行: サブエージェントカードのイベント型）
- `packages/jimmy/src/gateway/api.ts`（+2 行: SSE 配信）
- Next.js UI: サブエージェントカードの描画コンポーネント（新規）

**リスク**: 高（PTY/SSE 基盤前提）。**順序**: #7 完了後。

---

## 7. Interactive Claude PTY エンジン（最大価値・最大コスト）

本家 `1d36d75` → `b03e904` → engine sprint。`claude -p`（headless, API 従量課金）を
**インタラクティブ PTY**（Max 定額プランで課金されるクラス）へ移行する。**コスト最大の改善点**。

**新規ファイル（本家から移植）**:
| ファイル | 行数 | 役割 |
|---------|------|------|
| `engines/claude-interactive.ts` | 760 | PTY 起動・Stop フック・ターン解決・割り込み |
| `engines/pty-lifecycle.ts` | 150 | warm-PTY ライフサイクル（kill vs keep-warm 判定） |
| `engines/pty-view-engine.ts` | 33 | PTY ビュー（CLI transcript 連携） |
| `engines/sse-pty-proxy.ts` | 331 | SSE インターセプト（単語単位ストリーム + 中間テキスト順序保持） |

**依存・前提**:
- `node-pty` 依存の追加（package.json）。
- `buildPtyEnv` による env ストリップ（gateway の sdk-cli 汚染を除去し `cc_entrypoint=cli` を保証 → Max 補助の課金クラスにする）。本家 `7e1a47d` / `f28a306` の検証ログ参照。
- Stop フックのレジストリ（`hookRegistry`）、watchdog（孤立リゾルバ対策）。
- コスト再構成: PTY は Stop フックにコストを持たないため transcript から `computeInteractiveCost()` で再計算。
  → ここで `lastTurnContextTokens()` を使い**コンテキストメーターも interactive 経路で populate**（#2 と統合済みの設計）。

**移植方針（段階）**:
1. `node-pty` 追加 + `pty-lifecycle.ts` / `pty-view-engine.ts` 移植（独立性高）。
2. `claude-interactive.ts` 移植。OpenRyoko の `EngineRunOpts`/`EngineResult`/`InterruptibleEngine` 型に合わせて調整
   （rateLimit/turns/contextTokens フィールドは既に互換）。
3. `sse-pty-proxy.ts` 移植（ストリーミング + サブエージェント分類は #6 と共有）。
4. エンジン登録: `gateway/server.ts` でエンジン選択に `claude-interactive` を追加。
   **当面は `claude -p` を残し、設定でオプトイン**（OpenRyoko の SSH リモート実行 `sshHost` と PTY の両立を確認するまで）。
5. SSH リモート実行（OpenRyoko 独自 `feat/employee: sshHost`）との整合性確認 — PTY をリモートで起動する場合の
   env ストリップ/pgid kill の二重化に注意。

**リスク**: 最高（新規 1,270 行 + ネイティブ依存 + 課金クラス検証 + OpenRyoko 独自 SSH との統合）。
**検証**: `claude-interactive*.test.ts` / `pty-lifecycle.test.ts` / `sse-*.test.ts` を本家から移植し green、
実セッションで `SessionStart` フックの `cc_entrypoint=cli` を確認（Max 補助の実証）。

---

## 推奨実装順序（Codex 向け）

```
[完了] 1. Slack fix
[完了] 2. コンテキストメーター
   ↓
3. Codex gpt-5.5 config 追補      （小・独立）
4. COO 廃止 / md 自動 ingest      （中・ペルソナ層と差分マージ）
5. 添付 API + キャッシュ          （中・gateway 先行、UI 後追い）
   ↓
7. Interactive PTY エンジン        （大・コスト最大価値、オプトイン導入）
6. サブエージェントカード          （#7 の SSE 基盤に依存）
```

各ステップで `npx tsc --noEmit`（jimmy + web）と `npx vitest run` を green に保つこと。
本家コードは `git show <commit>:packages/jinn/src/...` で参照し、`jinn`→`jimmy` のパス読み替え・
OpenRyoko 独自層（ペルソナ/メモリ/SSH/マルチコネクタ）との競合に注意して**差分マージ**する。
