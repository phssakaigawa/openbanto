# BANTO-PORT-PLAN — OpenBanto 独自変更の台帳（デグレ防止 / 上流マージ指針）

OpenBanto は3層のフォークチェーン上にある：

```
Jinn（土台） → OpenRyoko（Slack 振る舞い） → OpenBanto（IBM Bob 対応ほか）
```

本書は、上流（OpenRyoko / Jinn）の更新を取り込むときに **OpenBanto 独自の変更を潰さない（デグレさせない）** ための台帳。`PORT-PLAN.md`（Jinn→OpenRyoko 移植設計）に対応する **OpenBanto 版**。

---

## 3層の切り分け

### 🧱 Jinn 由来（土台・変えていない強み）
常駐デーモン / AIエージェント組織（部門・階級・タスクボード）/ cron / Web ダッシュボード / MCP / skills / マルチエンジン枠組み / `JINN_HOME` という home 概念。内部識別子 `JINN_HOME`・`jinn` はそのまま。

### 🌸 OpenRyoko 由来（Jinn に足した機能・OpenBanto は継承）
Slack 振る舞い系（空気読みトリアージ / `/goal` Stop hook / Agents View Canvas / 発言者認識 / DM-equivalent 検出）、Interactive PTY エンジン、コンテキストメーター、xterm CLI ビュー、Telegram コネクタ、ペルソナ/メモリ層、`~/.ryoko` home、パッケージ `jimmy`、Next.js web。
→ 詳細は同ディレクトリの `PORT-PLAN.md`（Jinn→OpenRyoko）を参照。**これらは OpenBanto 独自ではない**。

### 🍵 OpenBanto 由来（このフォークの独自変更 ＝ 以下が本書の本体）
本質は **IBM Bob 対応**。その他は付随整備。以下 file:location 付きで棚卸し。

---

## OpenBanto 独自変更の一覧（file / 目的 / ★上流マージ時のデグレ源）

### A. IBM Bob エンジン（中核）
| 変更 | 場所 | 注意（デグレ源） |
|---|---|---|
| Bob セッションエンジン（新規） | `packages/jimmy/src/engines/bob.ts` | 新規ファイル。上流に無い。`InterruptibleEngine` 実装、`bob run --format json` の単一 JSON を parse、`--resume <task_id>` で会話継続、stdin 即クローズ |
| one-shot に bob | `shared/oneShotCli.ts`（`OneShotEngine` union / `defaultBinForEngine` / `buildArgs` / `extractBobResult`） | 上流が OneShotEngine を触ったら bob 分岐を再適用 |
| エンジン登録 | `gateway/server.ts`（`BobEngine` import・instantiate・`engines.set("bob", …)`・Map 型 union） | 上流の engine セットアップ変更時に再適用 |
| config 型 | `shared/types.ts`（`engines.default` union / `engines.bob?` / `fallbackEngine?` に `"bob"`） | 型 union に bob を維持 |
| **★エンジン設定選択の bob 分岐（最重要）→ registry に集約済** | 旧: `sessions/manager.ts` / `gateway/api.ts` / `sessions/context.ts` / `cli/migrate.ts` の三項×4。**現在は `engines/registry.ts` の `resolveEngineConfig(config, name)` 一箇所に集約**（各サイトはこれを呼ぶだけ） | **bob 分岐が消えると `bin` が claude にフォールバックして起動失敗**（実際に踏んだバグ）。この選択は `resolveEngineConfig` に一元化した＝`engines[name] ?? engines.claude`。**上流がこの三項を復活/refactor したら `resolveEngineConfig` に寄せ直す**（bob/外部エンジンは必ず自分のブロックに解決すること）。詳細は `docs/design/engine-plugins.md` |
| resolveBin の bob 案内 | `shared/resolveBin.ts`（`INSTALL_HINTS.bob` = 公式 curl / `formatSpawnError` の basename フォールバック） | 維持 |
| Web UI にエンジン露出 | `shared/models.ts`（`ENGINE_NAMES`/`SYNTH_DEFAULTS`/`EFFORT_MECHANISM` に `bob`）＋ `packages/web/src/app/settings/page.tsx`（Default Engine 選択肢・「IBM Bob」設定セクション・ローカル `Config` 型に `bob?`） | 上流が `ENGINE_NAMES` や settings を refactor したら bob を再追加。bob はモデル選択なし（キー紐づけ） |

### B. WhatsApp を optional plugin 化（コア MIT クリーン）
| 変更 | 場所 | 注意 |
|---|---|---|
| baileys を dynamic import 化 | `connectors/whatsapp/index.ts`（`loadBaileys()` + `type … = any` + `start()` 冒頭で `await loadBaileys()`） | 上流が static import に戻すとコアが GPL を巻き込む。dynamic を維持。**event callback の `({…}: any)` も維持**（無いと baileys 不在時に `tsc` 失敗） |
| baileys を optional peer dep | `packages/jimmy/package.json`（`peerDependencies` + `peerDependenciesMeta.optional`） | **`dependencies` に戻さない** |

### C. 番頭ペルソナ + 「ご記帳」オンボーディング
| 変更 | 場所 | 注意 |
|---|---|---|
| identity を番頭に | `sessions/context.ts` `buildIdentity()`（番頭 front-of-house / 委譲 / 名前は当て字しない） | 上流が identity 文面を変えたら番頭ペルソナを再適用 |
| ONBOARDING を「ご記帳」に | `sessions/context.ts` `buildEvolutionContext()`（`isNew` 時の ONBOARDING MODE 文面） | 同上。※オンボ発火条件は **§O で per-user 化**：その発話者の `~/.openbanto/knowledge/users/<userKey>/profile.md` が50字未満か否か（旧グローバル `user-profile.md` は後方互換で operator のみ既知扱い。`portal.onboarded` は Web ウィザード専用で無関係） |

### D. home リブランド `~/.openbanto`
| 変更 | 場所 | 注意 |
|---|---|---|
| home 解決 + 自動 migration | `shared/paths.ts` | 既定 `~/.openbanto`、`~/.ryoko`/`~/.jinn` から自動移行。`OPENBANTO_HOME`/`OPENBANTO_INSTANCE` 新設、旧 env 後方互換。**定数名 `JINN_HOME` は内部互換で維持（値だけ変更）**。★前回この移行ロジックを一括 sed で壊した事故あり → **paths.ts は全面上書き禁止・差分で** |
| model 向け `~/.jinn` → `~/.openbanto` | `context.ts` / `setup.ts` / `jobs/state.ts` / `gateway/files.ts` | プロンプト等に出るパス文字列の追随 |
| `OPENBANTO_SERVICE` | `gateway/lifecycle.ts` / `bin/jimmy.ts` | `RYOKO_SERVICE` 後方互換つき |

### E. リブランド（ブランド文字列）
- `OpenRyoko`/`Ryoko` → `OpenBanto`/`Banto`（約57ファイル）。`portalName` 既定 `Banto`、ログ、CLI bin（`openbanto` ＋ `ryoko` エイリアス）、package 名（`openbanto` / `@openbanto/web`）。
- **保持（rename しない）**: `LICENSE`、`NOTICE`、README/CHANGELOG の **OpenRyoko / Jinn 出典表記**、内部識別子 `JINN_HOME`・`jinn`、`docs/upstream-port/PORT-PLAN.md`（OpenRyoko の設計メモ）。
- ⚠️ 一括 sed の教訓：`OpenRyoko` には「**改名対象**」と「**出典として残す**」の2種がある。CHANGELOG/謝辞/差別化を一括置換すると**上流の功績を横取り**する（是正済）。

### F. メタ / 資産
- `NOTICE`（Jinn → OpenRyoko → OpenBanto の出典 + IBM 非提携）
- `README`（IBM Bob 既定 + 正しい帰属）、`CHANGELOG`（OpenBanto 独自のみ）
- `assets/banto-avatar.png`（`jinn-showcase.gif` は Jinn のもの→削除）
- `scripts/systemd/openbanto.service`（`openryoko.service` から rename。install.sh の参照名と一致させて修理）

### G. エンジンをプラグイン化（コネクタ同様の機構、OpenBanto 独自）
本質は **A の Bob 対応を「エンジン一般化」に昇格**させたもの。挙動不変。詳細は `docs/design/engine-plugins.md`。

| 変更 | 場所 | 注意（デグレ源） |
|---|---|---|
| engine-sdk パッケージ（新規） | `packages/engine-sdk/`（`@openbanto/engine-sdk`, 依存0・型のみ・connector-sdk と同型の雛形） | 外部エンジンプラグインの契約。core `shared/types.ts` の `Engine`/`InterruptibleEngine`/`EngineRunOpts`/`EngineResult`/`StreamDelta` と**構造的に一致**を維持（ロード境界の代入互換条件）。上流が turn 契約を変えたら両方を追随 |
| エンジン registry（新規） | `packages/jimmy/src/engines/registry.ts`（`BUILTINS` lazy factory / `resolveEngine` / `hasBuiltinEngine` / `CAPABILITIES` テーブル / `engineCapabilities` + predicates / **`resolveEngineConfig`** / `defineEnginePlugin`） | connectors/registry.ts と同型。core は SDK を実行時依存にしない（型は自前コピー）。**capability テーブルが engine 名分岐の唯一の真実** |
| bob を SDK 第1号に | `engines/bob.plugin.ts`（`defineEnginePlugin`＋`CAPABILITIES.bob`＋lazy `import("./bob.js")`） | bob.ts 本体は不変。plugin 経由で解決される第1号。README/engine-plugins.md に明記 |
| 生成集約 | `gateway/server.ts`（旧 `new *Engine()`×4 → configured engine を `resolveEngine().create()` でループ構築。interactive Claude は "claude" キーを差し替え。shutdown は engines Map を回して killAll） | 上流の engine セットアップ変更時に再適用。**interactive Claude 差し替えと headless fallback（`claudeEngine` を interactive に渡す）を維持** |
| capability 参照化 | `sessions/manager.ts`/`gateway/api.ts`（`processLifetime`=interactive、sync=syncResume）、`sessions/fork.ts`（supportsFork ガード）、`shared/models.ts`（`ENGINE_NAMES`=registry の `BUILTIN_ENGINE_NAMES`） | `=== "claude"` を capability に置換した箇所。上流が名前分岐を復活させたら capability 参照に寄せ直す |
| config 型を string に開く | `shared/types.ts`（`engines.default`=`EngineName`、各ブロックに `module?`、`[engine:string]` index、`fallbackEngine` に `(string&{})`。`EngineName`/`EngineConfigBlock`/`BuiltinEngineName` 新設） | 既知リテラルの補完は維持しつつ外部エンジン名を許容。runtime schema は無い（YAML cast）ので型だけ |
| **意図的に残した名前分岐** | rate-limit の**primary**判定（`session.engine === "claude" && strategy==="fallback"` 等）と `oneShotCli.ts` の `buildArgs` per-CLI switch | Claude 特有挙動 / 各 CLI の flag は engine 固有。capability 化しない（理由は engine-plugins.md） |

### H. ガードレールをプラグイン化（コネクタ/エンジン同様の機構、OpenBanto 独自）
ターン単位の permission / approval / audit を **connector・engine と同じプラグイン方式**で core に組み込んだもの。**opt-in**（未設定なら組込 no-op「allow-all」で挙動不変）。詳細は `docs/design/guardrails-hooks.md`。

| 変更 | 場所 | 注意（デグレ源） |
|---|---|---|
| guardrail-sdk パッケージ（新規） | `packages/guardrail-sdk/`（`@openbanto/guardrail-sdk`, 依存0・型のみ・connector-sdk と同型の雛形, publishConfig public） | 外部ガードレールプラグインの契約。core `guardrails/registry.ts` の `Guardrail`/`GuardrailContext`/`GuardrailDecision`/`GuardrailTurnResult`/`GuardrailPlugin` と**構造的に一致**を維持（ロード境界の代入互換条件）。上流が turn 契約を変えたら両方を追随 |
| guardrail registry（新規） | `packages/jimmy/src/guardrails/registry.ts`（型コピー / `resolveGuardrail(module?)` / 組込 no-op「allow-all」default / `defineGuardrailPlugin`） | connectors/registry.ts と同型。core は SDK を実行時依存にしない（型は自前コピー）。**module 未指定は allow-all を返す（opt-in の要）**。load 失敗は「Install it: npm i <module>」 |
| 参照実装（新規） | `packages/jimmy/src/guardrails/example.plugin.ts`（`defineGuardrailPlugin`＋blocklist deny＋afterTurn audit `logger.info`） | 「プラグインとして動く」証明。`resolveGuardrail(path)` で読める第1号。README/guardrails-hooks.md に明記 |
| 起動時注入 | `gateway/server.ts`（`resolveGuardrail(config.guardrails?.module)` → `.create(config.guardrails?.config ?? {}, { logger, config })` を1回、`new SessionManager(config, engines, connectorNames, guardrail)` の第4引数で注入） | engines Map と同じ注入経路。上流の SessionManager 生成箇所変更時に再適用。**guardrail を渡し忘れると SessionManager 側 default（allow-all）に fallback** |
| ターン実行路の hook（★中核） | `sessions/manager.ts` `runSession()`：**beforeTurn** = budget check の隣（`engine.run` 直前）。allow→続行 / deny→reason 返信+ターン終了（audit も呼ぶ） / require_approval→`parkForApproval`（`queue.pauseQueue`＋decision gate）。**afterTurn** = 主経路の `engine.run` 復帰後（`ok/cost/tokens`、throw を握り潰す）。承認解決は `resolveApproval(sessionKey, approved, opts?)` を公開（承認UIは拡張側） | **★最重要デグレ源: beforeTurn/afterTurn が turn 実行路から外れていないか。** 上流が runSession の budget 近傍や result delivery を書き換えたら、hook 2点を再配置。fallback/retry 分岐は afterTurn 未網羅（主経路のみ）だが、主経路が外れると audit が全滅する |
| config 型 | `shared/types.ts`（`JinnConfig.guardrails?: { module?: string; config?: Record<string, unknown> }`） | runtime schema は無い（YAML cast）ので型だけ。上流が JinnConfig を再定義したら再追加 |

---

### I. プラグイン管理UI（Gated Install、OpenBanto 独自）
engine / connector / guardrail の3プラグイン機構を **WebUI + gateway API から閲覧・インストール**できるようにしたもの。install は `pnpm add <module>` を叩く＝**デーモンと同一権限で任意コードを実行する強力操作**なので、**opt-in**（`config.plugins.manageUi:true` 未設定なら全 `/api/plugins/*` が 403）かつ **Keycloak/oauth2-proxy エッジ認証の前段**に置き、**サーバ側でグループを再チェック**する設計。詳細は `docs/design/plugin-manage-ui.md`。

| 変更 | 場所 | 注意（デグレ源） |
|---|---|---|
| config 型 | `shared/types.ts`（`JinnConfig.plugins?: { manageUi?: boolean; adminGroup?: string; installRoot?: string }`, 既定 `manageUi:false`・`adminGroup:"openbanto-admins"`） | runtime schema なし（YAML cast）。上流が JinnConfig を再定義したら再追加。`gateway/api.ts` の `PUT /api/config` `KNOWN_KEYS` に `plugins`（と `guardrails`）を追加済 — 上流が KNOWN_KEYS を再定義したら再追加 |
| gateway API（新規） | `packages/jimmy/src/gateway/plugins-api.ts`（`requirePluginAdmin` / `validateModuleSpec` / `summarizePlugins` / `installPlugin` / `togglePlugin` / `updatePluginConfig` / `auditPluginAction`） | **★セキュリティ中核**。①`manageUi!==true`→403 ②`X-Forwarded-Groups` に `adminGroup` 含む→許可 / ヘッダ無しは **loopback のみ許可** ③module は **npm名 or git+https のみ**（shell メタ文字・ローカルパス拒否）④`pnpm add` は **execFile（argv 配列, シェル非経由）** ⑤全操作を監査。上流が req/socket 形を変えたら loopback 判定を追随 |
| ルータ配線 | `gateway/api.ts`（`/api/plugins`・`/api/plugins/*` を `handleApiRequest` に追加、`context.auditSink` 追加） | 各ルートで `requirePluginAdmin` を必ず通す。connector は `reloadAllConnectors()` で即 reload、engine/guardrail は `needsRestart:true` を返す |
| 監査 sink 注入 | `gateway/server.ts`（`apiContext.auditSink = guardrail`） | 起動時 guardrail を監査 sink に流用。guardrail 生成箇所を上流が動かしたら再配線（未注入でも `logger.info` は出る） |
| registry 露出 | `connectors/registry.ts`（`BUILTIN_CONNECTOR_TYPES` を新規 export） | builtin/module 判定に使用。engine 側は既存 `BUILTIN_ENGINE_NAMES` を流用 |
| WebUI（新規） | `packages/web/src/app/plugins/page.tsx` + `lib/nav.ts`（`/plugins`）+ `lib/api.ts`（`getPlugins`/`installPlugin`/`togglePlugin`/`updatePluginConfig`+`PluginsSummary`型） | 信頼警告バナー常設・`manageUi:false` 時は無効カード表示で install フォーム非表示。UI 表示制御は**認可の代わりにならない**（サーバ再チェックが本体） |
| reload 方針 | — | **connector=即 hot-reload**（`reloadAllConnectors`）/ **engine・guardrail=起動時1回生成のため再起動要**（`needsRestart:true`→UI が再起動を促す）。無停止 hot-swap はスコープ外 |
| 単体テスト | `gateway/__tests__/plugins-api.test.ts`（`validateModuleSpec` の command injection/ローカルパス/protocol 拒否 + `requirePluginAdmin` gate + `summarizePlugins`） | module バリデーションの回帰検知。上流が execFile/シェル配線を触ったら再確認 |

### J. 汎用 OpenAI 互換エンジン（`impl:"openai"`）＋Web 設定フォーム（OpenBanto 独自）
`docs/design/http-engine-skeleton.md` の申し送りを**組込み実装**として取り込んだもの。任意名のエンジンを **1 実装（openai）で複数**定義でき（`engines.aidea`/`engines.kannon` …）、各々 baseUrl/apiKey/model を持つ。CLI ではなく HTTP（`/v1/chat/completions` `stream:true`）で会話し、SSE を `onStream` に転送、最終テキストを `EngineResult.result` に集約。**tool-call/MCP はスコープ外**（`mcpConfigPath` 無視・TODO）。

| 変更 | 場所 | 注意（デグレ源） |
|---|---|---|
| エンジン実装（新規） | `packages/jimmy/src/engines/openai.ts`（`OpenAiEngine implements InterruptibleEngine` + `parseSse`） | sessionId 毎 `AbortController`（kill=abort/isAlive/killAll、abort→`error:"interrupted"`）。`usage.prompt_tokens`→contextTokens、`usage.cost`→cost。**apiKey をログ/レスポンスに出さない**。resume は sessionId 毎の in-memory transcript（MVP・再起動で消失、`syncResume:false`） |
| プラグイン（新規） | `packages/jimmy/src/engines/openai.plugin.ts`（`defineEnginePlugin` name="openai"、`create` で baseUrl/apiKey/model 欠如時 throw） | capabilities= `transport:"http"` 他すべて false・`effort:"none"`。create は動的 import で `OpenAiEngine` 生成 |
| registry（impl 解決） | `engines/registry.ts`（`IMPL_PLUGINS`/`IMPL_CAPABILITIES`/`ENGINE_IMPL_NAMES`/`engineImplOf`、`resolveEngine(name, block)` に **第3経路**＝block.impl、`engineCapabilities(name, config)` が impl 参照、`resolveEngineConfig` 戻り型に impl/baseUrl/apiKey） | **★builtin 名でも module でもない第3経路**。上流が resolveEngine 署名を変えたら block 受理を追随。builtin 名を優先し impl はその後 |
| engine map 構築 | `gateway/server.ts`（builtin + `module` **または** `impl` を持つ config engine を列挙、`cfg.name`＝config キーを注入） | impl エンジンの `name` は config キー（aidea/kannon）。列挙条件に impl を落とすと生成されない |
| model picker 配線 | `shared/models.ts`（`addImplEngineEntries`＝`engines.<name>.model` を registry に追加、`buildRegistry`/`synthesizeFromEngineConfig` 双方で呼ぶ） | builtin 以外も /model 切替対象に。上流が registry 構築を作り直したら再配線 |
| config 型 | `shared/types.ts`（`EngineConfigBlock` に `impl?:"openai"`/`baseUrl?`/`apiKey?`/`headers?`/`temperature?`） | 既存 `module?`/`bin?`/`model?` と併存。`engines` index signature で任意名許容（既存） |
| gateway API（新規） | `gateway/plugins-api.ts`（`upsertOpenAiEngine`＝**pnpm add しない**・config `engines.<name>` に `{impl:"openai",…}` 書込・`needsRestart:true`）+ `gateway/api.ts` `POST /api/plugins/engine-openai` | **★pnpm add 不要**（組込み実装）。name=`[a-z0-9-]+`・builtin/`default` 予約名拒否、baseUrl=http(s) のみ。**apiKey は再入力時のみ更新・空なら据置**、レスポンスに返さない（summary は `openai.hasApiKey` のみ）。監査は name のみ |
| WebUI（フォーム） | `packages/web/src/app/plugins/page.tsx`（`OpenAiEngineSection`/`OpenAiEngineForm`）+ `lib/api.ts`（`upsertOpenAiEngine`+`PluginEntry.impl`/`openai`） | 型付き入力（生 JSON でない）: name/baseUrl/apiKey(password)/model/temperature。編集時 apiKey 空欄＝据置。再起動要を明示 |
| 単体テスト | `engines/__tests__/openai.test.ts`（`parseSse` の分割フレーム/[DONE]/非JSON、run のストリーム集約・usage・**apiKey 非漏洩**・abort→interrupted・killAll） | 実 HTTP は叩かず ReadableStream 模擬。SSE パース＋abort の回帰検知 |

---

### K. サンプル・ガードレール ポリシーパック（`impl:"sample"`）＋Web 設定フォーム（OpenBanto 独自）
§H のガードレール機構の上に、**組込み・設定駆動のサンプルポリシー**を載せたもの。§J の `impl:"openai"` エンジンと同型で、外部モジュールを `pnpm add` せずに **Web フォームから本物の permission/approval/audit ポリシーを投入**できる。**opt-in**（`impl` 無指定なら従来通り no-op「allow-all」で挙動不変）。判定は `GuardrailContext` の `userId/toolbelt/text` 基準（**Keycloak groups はターン文脈に無い**）。詳細は `docs/design/guardrails-hooks.md`。

| 変更 | 場所 | 注意（デグレ源） |
|---|---|---|
| サンプル実装（新規） | `packages/jimmy/src/guardrails/sample.plugin.ts`（`defineGuardrailPlugin` name="sample"、config駆動 beforeTurn/afterTurn） | **beforeTurn 判定順序=①allowUsers→allow ②deny(text.toLowerCase contains)→deny ③requireApproval(toolbelt∩tools)→require_approval ④allow**。config 全欠如は allow（安全側）。afterTurn=`{ts,who,connector,channel,engine,ok,cost,tokens,error?}` を sink へ（log=logger.info 1行 / http=best-effort fetch POST・**throw しない**）。**endpoint/auth header と生 text をログ・レコードに出さない** |
| registry（impl 解決） | `guardrails/registry.ts`（`IMPL_PLUGINS`/`GUARDRAIL_IMPL_NAMES`/`guardrailImplOf`、`resolveGuardrail(blockOrModule)` を **module→impl→no-op** の3経路化） | §J の engine impl と同型。`resolveGuardrail` は後方互換で string(module) も受理。**module 優先、その後 impl、最後に no-op**。上流が引数を module 文字列前提に戻したらブロック受理を追随 |
| 起動時注入 | `gateway/server.ts`（`resolveGuardrail(config.guardrails)` にブロック全体を渡す、impl 時にログ） | ブロックを渡さないと impl 経路が死ぬ（module だけ見て no-op fallback） |
| config 型 | `shared/types.ts`（`guardrails?: { module?; impl?; config? }` に `impl?` 追加） | runtime schema なし（YAML cast）。`gateway/api.ts` `KNOWN_KEYS` の `guardrails` は既存流用 |
| gateway API（新規） | `gateway/plugins-api.ts`（`setGuardrail`＝**pnpm add しない**・policy=none/sample/module で `guardrails` ブロック書込・`needsRestart:true`）+ `gateway/api.ts` `POST /api/plugins/guardrail`（`requirePluginAdmin`・監査） | policy=none→ブロック削除(allow-all)、sample→flat フィールドから `{impl:"sample",config}` 組立、module→`validateModuleSpec` 流用。**auditEndpoint はレスポンスに返さない・監査は policy 種別のみ**。auditSink=http は endpoint を http(s) 検証 |
| summary マスク | `gateway/plugins-api.ts`（`summarizePlugins` guardrail に `impl`/`sample`＝`{allowUsers,denyKeywords,approvalTools,approvers,auditSink,hasAuditEndpoint}`、`PluginEntry.sample` 追加、`summarizeSampleConfig`） | **endpoint は `hasAuditEndpoint` にマスク**、生値を返さない |
| WebUI（フォーム） | `packages/web/src/app/plugins/page.tsx`（`GuardrailSection`, ガードレールタブ）+ `lib/api.ts`（`setGuardrail`+`PluginEntry.sample`） | ポリシー種別 None/Sample/External を select、Sample=カンマ区切り入力、External=module+JSON。現状 prefill・信頼警告バナー（ターン実行を止める強い権限）・再起動要を明示 |
| 単体テスト | `guardrails/__tests__/sample.plugin.test.ts`（beforeTurn の allow/deny/require_approval 分岐＋順序・空config allow・afterTurn log/http のthrow なし・**endpoint 非ログ**） | impl 解決経路で beforeTurn 分岐を回帰検知 |

---

### L. WebUI からのデーモン自己再起動（Banto 再起動、OpenBanto 独自）
§I〜K の「engine/guardrail 変更は `needsRestart:true`」を、**運用者がボックスに SSH せず WebUI から再起動**できるようにしたもの。番頭は **systemd(user) ユニット `getworks-banto`（`Restart=always`）** で常駐（実機 `gw-banto01`）＝プロセスが SIGTERM/正常終了すると systemd が自動復帰する。この事実を使い、`systemctl` を**外部から叩かず**「**自プロセスへ SIGTERM**」で再起動する（`execFile`/`systemctl` 不使用）。管理ゲート・監査は §I の `/api/plugins*` と同一。詳細は `docs/design/plugin-manage-ui.md` § restart。

| 変更 | 場所 | 注意（デグレ源） |
|---|---|---|
| 自己再起動機構（新規） | `packages/jimmy/src/gateway/self-restart.ts`（`armSelfRestart({delayMs,kill,pid})` / `isRestarting()`／モジュールスコープ `restarting` フラグで single-flight） | **★`systemctl` を叩かない**（`Restart=always` に委ねる）。200 flush 用に **遅延 700ms 後** `process.kill(process.pid,"SIGTERM")`。`kill`/`pid` は注入可（テストで実プロセスを殺さない）。timer は `unref()` |
| ルータ配線 | `gateway/api.ts`（`POST /api/admin/restart` を `handleApiRequest` に追加） | **`requirePluginAdmin` 必須**（§I と同一ゲート）→ 非admin/機能OFF=403。`auditPluginAction({action:"daemon.restart"})`。**先に 200 `{restarting:true}` を返し**、その後 `armSelfRestart`。in-flight は `isRestarting()`→ **409 `{restarting:true,already:true}`**（`armSelfRestart` を呼ばない） |
| shutdown 再利用 | `gateway/lifecycle.ts`（既存 SIGTERM ハンドラ "Shutting down gateway…"） | 新規コードなし。SIGTERM→既存グレースフル shutdown（running セッション interrupted 化・engines killAll・connectors stop・HTTP/WS close、5s 強制終了バックストップ）→`process.exit(0)`→systemd 復帰。**上流が SIGTERM ハンドラ/cleanup を動かしたら自己再起動が graceful でなくなる** |
| WebUI（ボタン） | `packages/web/src/app/plugins/page.tsx`（`RestartBantoButton`、ヘッダの 再読込 隣、`manageUi:true` 時のみ）+ `lib/api.ts`（`restartDaemon`＋`pollDaemonHealthy`） | 確認ダイアログ→POST→「再起動中…」→`/api/status` を ~1.5s 間隔 poll（down 中の fetch 失敗は握り潰しリトライ）→200 で「復帰しました」→データ再取得。連打防止（busy 中 disabled）・poll timeout/失敗はインラインメッセージ |
| 単体テスト | `gateway/__tests__/self-restart.test.ts`（single-flight＋遅延 SIGTERM を注入 kill で検証）+ `gateway/__tests__/admin-restart-endpoint.test.ts`（非admin→403・manageUi 無効→403・admin→`restarting`・in-flight→409、self-restart は mock） | **プロセスを実際に殺さない**（fake timer＋注入 kill／self-restart.js を mock）。上流が req/socket 形やゲートを変えたら追随 |

### M. MCP サーバ登録の Web 設定フォーム（職人/tools、OpenBanto 独自）
§I の Gated 管理 UI に **MCP サーバ（`config.mcp.custom.<name>`）の UI 登録**を足したもの。stdio（`command`/`args`/`env`）と URL（HTTP/SSE：`type:"sse"` 固定・`url`・認証は `headers`）の 2 トランスポートを一覧/追加/編集/削除/enabled トグルできる。**MCP は per-turn 解決**（`mcp/resolver.ts` `resolveMcpServers`）なので、config 書き込み後は **config watcher →`sessionManager.setConfig` →次ターンで反映**＝**再起動不要（`needsRestart:false`）**。ゲート・監査は §I の `/api/plugins*` と同一。詳細は `docs/design/tools-mcp-wiring.md` § UI 登録。

| 変更 | 場所 | 注意（デグレ源） |
|---|---|---|
| summary マスク（新規） | `gateway/plugins-api.ts` `summarizeMcpServers`（`PluginsSummary.mcpServers[]` に追加） | **★headers/env の値と URL 内トークンを返さない**（`hasHeaders`/`hasEnv` の bool のみ。`url`/`command` は表示可）。上流が summary 形を変えたら追随 |
| upsert/削除（新規・純粋関数分離） | `gateway/plugins-api.ts` `buildMcpBlock`（純粋：バリデーション＋secret 据置マージ）/ `mergeSecretMap`（空欄＝既存維持）/ `upsertMcpServer` / `deleteMcpServer` | **★secret 据置**：編集時 headers/env 値が空欄なら既存を維持（非空で上書き、省略で削除）。**値をレスポンス・監査に出さない**。`name` は `[a-z0-9-]+`、URL は http(s)、stdio は command 非空。**`pnpm add`/`execFile` 不使用**（config 配線のみ） |
| ルータ配線 | `gateway/api.ts`（`POST /api/plugins/mcp`＝upsert・`action:"delete"`可 / `DELETE /api/plugins/mcp?name=…`） | **`requirePluginAdmin` 必須**（§I と同一ゲート）＋`auditPluginAction({action:"mcp.upsert"|"mcp.delete", name, transport})`（**transport のみ・値なし**）。patched 後に `context.config=getConfig()` で GET を即時反映 |
| resolver enabled 尊重 | `mcp/resolver.ts` `buildAvailableServers`（`if (serverConfig.enabled === false) continue;`） | **既存の skip をそのまま利用**（無効サーバは登録しない）。上流が custom 解決を変えたら enabled skip が消えていないか確認 |
| WebUI（タブ/フォーム） | `packages/web/src/app/plugins/page.tsx`（`McpSection`/`McpServerForm`/`SecretKvEditor`、MCP タブ）+ `lib/api.ts`（`upsertMcpServer`/`deleteMcpServer`＋`McpServerSummary`/`mcpServers`） | 信頼警告バナー＋**エンジン対応ヒント**（claude 消費・bob 非対応・openai は tool-call 実装後）。secret 欄は password・編集時は空欄プレースホルダで「設定済」表示（prefill しない） |
| 単体テスト | `gateway/__tests__/plugins-api.test.ts`（`mergeSecretMap` 据置/上書き/削除・`buildMcpBlock` バリデーション＋secret 据置・`summarizeMcpServers` マスク＝serialize に秘匿値が出ないこと） | disk I/O を伴わない純粋関数を検証（`upsertMcpServer` の read/write は薄いラッパ） |

### N. OpenAI 互換エンジンの MCP tool-call ブリッジ（OpenBanto 独自）
§J の `impl:"openai"` エンジンに **MCP tool-call 対応**を足したもの。これまで `opts.mcpConfigPath` は無視（TODO）だったが、config が MCP サーバを返すとき、各サーバへ **MCP クライアント接続**（stdio＝`StdioClientTransport`／URL＝`type:"sse"` は `SSEClientTransport`・それ以外は `StreamableHTTPClientTransport`、`headers` は `requestInit` 経由）し、全サーバの `listTools()` を **`"<server>__<tool>"` に名前空間化**して OpenAI `tools`(function) へ変換する。以後は **非 stream** の `POST /v1/chat/completions`（`tools`＋`tool_choice:"auto"`）を回し、`tool_calls` を **MCP で実行**→結果を `{role:"tool"}` で積む→次ラウンド、を **最大 8 ラウンド**繰り返す。`tool_calls` の無い回答が最終＝`onStream({type:"text"})` で流して終了。**ツール無し／`mcpConfigPath` 無しは従来どおり stream 平文チャット**（既存挙動不変）。MCP SDK は公式 `@modelcontextprotocol/sdk`（jimmy 依存に追加）。詳細は `docs/design/tools-mcp-wiring.md` / `http-engine-skeleton.md` / `engine-plugins.md`。

| 変更 | 場所 | 注意（デグレ源） |
|---|---|---|
| MCP ブリッジ（新規） | `mcp/tool-bridge.ts`（`McpToolBridge`＝connect/listTools 名前空間化/callTool 逆引き/close、SDK deps は注入可能＝`BridgeDeps`） | **★secret 非ログ**：接続失敗は握ってサーバ名のみ warn（env/headers 値を出さない）。SDK は ESM 専用＝`connect()` 内で **動的 import**（deps 注入時は SDK を読み込まない）。tool 名衝突は最初勝ち |
| tool-call ループ（新規） | `engines/openai.ts` `runToolLoop`（非 stream・8 ラウンド上限）/ `runStreaming`（従来路を関数抽出）/ `readMcpServers`（config 読み・throw しない） | **★従来 stream 路を壊さない**：ツール無し時は `runStreaming` で完全に従来挙動。MCP セットアップ失敗は turn を落とさず平文にフォールバック。ループ上限で暴走防止 |
| abort / cleanup | `engines/openai.ts` `kill`/`killAll`（AbortController に加え `liveBridges` を close）＋`run` の `finally` で必ず close | **★MCP クライアントのリーク防止**：kill は fire-and-forget close＋map から削除（finally との二重 close を回避）。abort は `interrupted` を維持 |
| 依存追加 | `packages/jimmy/package.json`（`@modelcontextprotocol/sdk ^1.30.0`）＋`pnpm-lock.yaml` | **コア MIT クリーンは維持**（SDK は MIT）。他パッケージと矛盾しない安定版 |
| 単体テスト（新規） | `engines/__tests__/openai.mcp.test.ts`（①tools 変換＋名前空間 ②tool_calls→MCP callTool→結果を messages→最終 text ③ツール無し=平文 ④abort で両方 close） | 実 HTTP/実 MCP を叩かずモック：`bridgeDeps` で fake Client 注入・`fetch` は stub。secret 非漏洩も assert |

### O. per-user knowledge scoping ＋ scoped「knowledge」MCP サーバ（OpenBanto 独自）
知識を **単一共有ファイル**（`knowledge/{user-profile,preferences,projects}.md`）から **発話者スコープ**へ。`sessions/context.ts` に `userKey(scope)`（`speakerSlackId` 優先→`speakerName` 正規化→`[a-z0-9_-]` 以外を落とし空なら `unknown`）を導入し、`buildEvolutionContext`/`buildKnowledgeContext` を **その発話者の** `knowledge/users/<userKey>/{profile,preferences}.md` ＋ 組織共通 `knowledge/shared/` に切替。**`isNew`（ご記帳）は per-user**＝その発話者の `profile.md` が50字未満か否か（初対面のユーザだけ挨拶）。後方互換：旧トップレベル `knowledge/*.md` は非破壊で shared 相当として併読、旧単一 `user-profile.md` が充実していれば operator（or 匿名）だけ「既知」扱いで再オンボーディングを防止。記録指示は **エンジン非依存**（claude=native / openai=`write_knowledge`）。あわせて新規 stdio MCP サーバ `mcp/knowledge-server.ts` を **既定 ON**（`mcp.knowledge?.enabled`、`gateway` と同じ配線＝`command:node,args:[knowledge-server.js]`）で追加：`read_knowledge`/`write_knowledge`/`list_knowledge` を **全て `~/.openbanto/knowledge/` にスコープ**、`..`/絶対/`~`/root 外シンボリックリンクを厳格拒否（`path.resolve` prefix ＋ 最深既存祖先の `realpathSync` 検証）、エラーに内部絶対パスを晒さない。→ AiDEA(openai) は MCP ブリッジ経由で、claude は MCP or native で per-user 知識を書ける。詳細は `docs/design/per-user-knowledge.md` / `tools-mcp-wiring.md`。

| 変更 | 場所 | 注意（デグレ源） |
|---|---|---|
| per-user 化＋`userKey`（新規） | `sessions/context.ts`（`userKey`/`buildEvolutionContext`/`buildKnowledgeContext` を `SpeakerScope` 受け取りに） | **★`isNew` を per-user profile.md で判定**（グローバル一本に退行させない）。後方互換：旧 `knowledge/*.md` を消さず併読、operator は再オンボしない |
| knowledge MCP サーバ（新規） | `mcp/knowledge-server.ts`（stdio・hand-rolled JSON-RPC＝`gateway-server.ts` に倣う。`resolveWithinRoot` でトラバーサル拒否） | **★root 逸脱拒否**（`..`/絶対/`~`/シンボリックリンク）。**内部絶対パス非漏洩**（エラー・成功応答とも root-相対のみ）。直接起動時だけ stdin ループ（`isDirectRun` gate＝テスト import で起動しない） |
| resolver 組込み＋config 型（変更） | `mcp/resolver.ts`（`gateway` 直後に `knowledge` を既定 ON 追加・dist 解決 fallback）＋`shared/types.ts` `McpGlobalConfig.knowledge?:{enabled}` | **★`knowledge.enabled!==false` で per-turn mcpConfig に必ず入る**（dist の `knowledge-server.js` パスが build 出力と一致）。`enabled:false` で skip |
| 単体テスト（新規） | `sessions/__tests__/user-key.test.ts` / `per-user-knowledge.test.ts` / `mcp/__tests__/knowledge-server.test.ts` ＋ `resolver.test.ts` 追記 | ①`userKey` 正規化 ②per-user `isNew`（片方 new・片方既知）＋listing 隔離 ③トラバーサル拒否＋IO round-trip ④resolver 既定 ON/無効化 |

### P. 番頭ID伝播 ＋ 職人 per-user 強制（OpenBanto 独自）
§O の per-user 知識を **全 MCP 職人（shokunin）へ一般化**したもの。番頭は **その回の発話者の identity を毎ターン自動注入**し、各職人が per-user に I/O する規約を強制する（calendar/ledger/議事録も全部その人単位）。`McpSessionContext` に `userId`/`userKey`/`userName` を追加（既存 `connector`/`channel`/`thread` に併設）。`sessions/manager.ts` の **2箇所**（mcpConfigPath 用・guardrail toolbelt 用）の `resolveMcpServers` 呼び出しで、`msg.userId`・`userKey({speakerSlackId,speakerName})`（`context.ts` の導出を再利用）・`msg.user` を渡す。`mcp/resolver.ts` は `buildAvailableServers` 末尾で **全職人**（browser/search/fetch/gateway/knowledge/custom）へ注入：**stdio→`env`** に `JINN_USER_ID`/`JINN_USER_KEY`/`JINN_USER_NAME`/`JINN_CONNECTOR`/`JINN_CHANNEL`（値があるものだけ・既存 env 保持・well-known キーは番頭が権威で上書き）、**url→`headers`** に `X-Banto-User-Id`/`-User-Key`/`-User-Name`/`-Connector`/`-Channel`（**静的認証 `Authorization` 等は保持**し X-Banto-* だけ付与）。identity 無し（cron/内部/旧呼び出し）は**注入ゼロ＝後方互換**。参照実装として `mcp/knowledge-server.ts` を identity 自動スコープ化：`JINN_USER_KEY` があれば **`users/<key>/` を既定ルート**（`profile.md`→`users/<key>/profile.md`）、`shared/…` は組織共通の逃げ道、未設定は従来 root 相対。**トラバーサル防止は維持**（rewrite は `resolveWithinRoot` の前・ユーザーサブツリーからも root 脱出不可）。ツール description に「あなたの I/O は現在のユーザーに自動スコープされます」を明記。契約は `docs/design/shokunin-contract.md`（HTTP 職人は `X-Banto-User-Id` を読む）。詳細は `tools-mcp-wiring.md` / `per-user-knowledge.md` の identity 伝播節。

| 変更 | 場所 | 注意（デグレ源） |
|---|---|---|
| `McpSessionContext` 拡張 | `mcp/resolver.ts`（`userId?`/`userKey?`/`userName?` 追加） | 既存 `connector`/`channel`/`thread` を壊さず併設 |
| identity 注入（新規） | `mcp/resolver.ts`（`buildAvailableServers` 末尾 `injectIdentity`＋`identityEnv`/`identityHeaders`） | **★全職人に適用**（stdio→env / url→headers）。**identity 無しは注入しない**（後方互換）。**url は `Authorization` 等の静的 auth 保持**・X-Banto-* だけ付与。stdio は既存 env 保持・well-known キーのみ上書き |
| manager 受け渡し（変更） | `sessions/manager.ts`（`userKey` import＋`speakerIdentity` を **2箇所**の `resolveMcpServers` に spread） | **★2箇所とも**（mcpConfigPath・guardrail toolbelt）。`userKey` は `context.ts` の導出を再利用（SlackID優先→正規化） |
| knowledge 自動スコープ（変更） | `mcp/knowledge-server.ts`（`normalizeUserKey`/`USER_KEY`/`scopePath`＋各ツールで `scopePath` 適用・description 更新） | **★`JINN_USER_KEY` 時 `users/<key>/` 既定**・`shared/` は逃げ道・未設定は従来。**トラバーサル防止維持**（`scopePath`→`resolveWithinRoot` の順・root 脱出不可）。内部絶対パス非漏洩維持 |
| 職人コントラクト doc（新規） | `docs/design/shokunin-contract.md` | env/header 一覧・全職人 per-user 必須・knowledge を参照実装・HTTP 職人は `X-Banto-User-Id` |
| 単体テスト（新規/追記） | `mcp/__tests__/resolver.test.ts` 追記 / `mcp/__tests__/knowledge-server-user-scope.test.ts`（新規） | ①stdio env に `JINN_USER_*` 注入・url headers に `X-Banto-*` 注入＋`Authorization` 保持 ②identity 無しは注入しない ③`JINN_USER_KEY` 時 `users/<key>/` 自動スコープ・`shared/` 共通・トラバーサル依然拒否 |

---

## 上流マージ時のチェックリスト（デグレ防止）
1. `engines/bob.ts` が残っているか（＋`engines/bob.plugin.ts` が registry から解決されるか）
2. **★エンジン設定選択が `engines/registry.ts` の `resolveEngineConfig` に集約されたままか**（`manager.ts`/`api.ts`/`context.ts`/`migrate.ts` が自前三項に戻っていないか。bob/外部エンジンが自分のブロックに解決されるか）← 最優先
2b. **capability テーブル**（`registry.ts` `CAPABILITIES`）が生きていて、interactive/fork/syncResume 判定が `=== "claude"` に退行していないか
3. `oneShotCli.ts` / `server.ts` / `types.ts` の bob 配線
4. `paths.ts` の `~/.openbanto` 既定 + 自動 migration（全面上書きされていないか）
5. `whatsapp/index.ts` が dynamic import のまま / `package.json` の baileys が optional peer のまま
6. `context.ts` の番頭 identity + 「ご記帳」ONBOARDING
6b. **★ガードレール hook が turn 実行路から外れていないか**（`sessions/manager.ts` `runSession()` の `beforeTurn`=budget check 隣・`engine.run` 直前 / `afterTurn`=主経路の `engine.run` 復帰後 が残っているか。`gateway/server.ts` が `resolveGuardrail().create()` を SessionManager 第4引数に注入しているか。未設定時に no-op「allow-all」で挙動不変か）
6c. **★プラグイン管理UIのセキュリティ gate が生きているか**（`gateway/plugins-api.ts` `requirePluginAdmin`＝`manageUi` flag→group 再チェック→loopback fallback / `validateModuleSpec` の npm・git+https 限定＋shell メタ拒否 / `pnpm add` が **execFile（シェル非経由）** のままか。`gateway/api.ts` `/api/plugins/*` 各ルートが gate を通しているか。`PUT /api/config` `KNOWN_KEYS` に `plugins`/`guardrails` が残っているか）
6e. **★MCP サーバ登録フォームが生きているか**（`gateway/plugins-api.ts` `summarizeMcpServers` が headers/env 値・URL 内トークンをマスク＝`hasHeaders`/`hasEnv` bool のみ返すか / `buildMcpBlock`+`mergeSecretMap` が編集時 secret 据置（空欄＝維持）か / `upsertMcpServer` が **`pnpm add`/`execFile` を叩かず** config 配線のみか。`gateway/api.ts` の `POST`/`DELETE /api/plugins/mcp` が `requirePluginAdmin` を通し監査に**値を出さない**か。`mcp/resolver.ts` が `enabled:false` を skip したままか。反映は per-turn＝`needsRestart:false`）
6d. **★汎用 OpenAI 互換エンジンが生きているか**（`engines/registry.ts` の impl 解決＝`resolveEngine(name, block)` 第3経路・`IMPL_PLUGINS.openai`・`engineImplOf` が残っているか。`gateway/server.ts` の engine map 列挙が `impl` を拾うか。`shared/models.ts` `addImplEngineEntries` で /model picker に出るか。`gateway/plugins-api.ts` `upsertOpenAiEngine` が **pnpm add を叩かず** apiKey を据置更新・非漏洩のままか。`openai.ts` が abort→`interrupted`・apiKey 非ログか）
6f. **★OpenAI 互換エンジンの MCP tool-call が生きているか**（`engines/openai.ts` が `mcpConfigPath` から `mcp/tool-bridge.ts` `McpToolBridge` 経由でツールを取得し、`"<server>__<tool>"` 名前空間で OpenAI `tools` 化・非 stream tool-call ループ（8 ラウンド上限）を回すか。ツール無し／config 無しは `runStreaming` で従来平文挙動のままか。`kill`/`killAll`/`finally` が MCP クライアントを close しリークしないか。stdio と URL(SSE/HTTP) 両 transport を扱い接続失敗を握って skip・**env/headers 値を非ログ**か。`@modelcontextprotocol/sdk` が jimmy 依存に残り、`tsc --noEmit` 0 エラーか）
6g. **★per-user knowledge scoping が生きているか**（`sessions/context.ts` `userKey()` が `speakerSlackId`優先→`speakerName`正規化→空は `unknown` のままか。`buildEvolutionContext` の **`isNew` が per-user `users/<userKey>/profile.md` 50字未満**で判定され、グローバル一本に退行していないか。旧 `knowledge/*.md` を **非破壊**で shared 併読し operator を再オンボしないか。組込み **`knowledge` MCP サーバ**が `mcp/resolver.ts` で **既定 ON**（`config.knowledge?.enabled!==false`）・dist の `knowledge-server.js` を解決し、`read/write/list_knowledge` が **`~/.openbanto/knowledge/` にスコープ**され `..`/絶対/`~`/root外シンボリックリンクを拒否・**内部絶対パス非漏洩**か。`McpGlobalConfig.knowledge?` が `types.ts` に残るか）
6h. **★番頭ID伝播 ＋ 職人 per-user 強制が生きているか**（`mcp/resolver.ts` `McpSessionContext` に `userId`/`userKey`/`userName` が残り、`buildAvailableServers` 末尾の `injectIdentity` が **全職人**に stdio→`JINN_USER_*` env / url→`X-Banto-*` headers を注入し、**url の静的 `Authorization` 等を保持**・**identity 無しは注入しない**か。`sessions/manager.ts` が **2箇所**の `resolveMcpServers` に `speakerIdentity`（`userKey` は `context.ts` 導出再利用）を渡すか。`mcp/knowledge-server.ts` が `JINN_USER_KEY` 時 **`users/<key>/` 既定**・`shared/` 逃げ道・未設定は従来 root 相対で、**`scopePath`→`resolveWithinRoot` の順でトラバーサル拒否**（root 脱出不可・内部絶対パス非漏洩）を維持するか。`docs/design/shokunin-contract.md` が残るか）
7. **ビルド**: baileys 不在で `cd packages/jimmy && tsc --noEmit` が **0 エラー**（コア MIT クリーンの証明）
8. **実機**: Slack で `@番頭` に bob が応答（ログの `Bob engine starting:` の bin が **claude に化けていない**こと）

## 上流を取り込む手順（推奨）
1. `git remote add upstream https://github.com/rsensui2/OpenRyoko` して差分を**ファイル単位でレビュー**。
2. 上表の「独自変更」ファイルは**全面上書きせず差分マージ**（特に `paths.ts` / 3つのエンジン選択三項 / `whatsapp/index.ts`）。
3. マージ後、上のチェックリスト → VM 実機スモークで回帰確認。
