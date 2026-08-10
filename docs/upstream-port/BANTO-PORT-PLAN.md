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
| ONBOARDING を「ご記帳」に | `sessions/context.ts` `buildEvolutionContext()`（`isNew` 時の ONBOARDING MODE 文面） | 同上。※オンボ発火条件は `~/.openbanto/knowledge/user-profile.md` が50字未満か否か（`portal.onboarded` は Web ウィザード専用で無関係） |

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

## 上流マージ時のチェックリスト（デグレ防止）
1. `engines/bob.ts` が残っているか（＋`engines/bob.plugin.ts` が registry から解決されるか）
2. **★エンジン設定選択が `engines/registry.ts` の `resolveEngineConfig` に集約されたままか**（`manager.ts`/`api.ts`/`context.ts`/`migrate.ts` が自前三項に戻っていないか。bob/外部エンジンが自分のブロックに解決されるか）← 最優先
2b. **capability テーブル**（`registry.ts` `CAPABILITIES`）が生きていて、interactive/fork/syncResume 判定が `=== "claude"` に退行していないか
3. `oneShotCli.ts` / `server.ts` / `types.ts` の bob 配線
4. `paths.ts` の `~/.openbanto` 既定 + 自動 migration（全面上書きされていないか）
5. `whatsapp/index.ts` が dynamic import のまま / `package.json` の baileys が optional peer のまま
6. `context.ts` の番頭 identity + 「ご記帳」ONBOARDING
6b. **★ガードレール hook が turn 実行路から外れていないか**（`sessions/manager.ts` `runSession()` の `beforeTurn`=budget check 隣・`engine.run` 直前 / `afterTurn`=主経路の `engine.run` 復帰後 が残っているか。`gateway/server.ts` が `resolveGuardrail().create()` を SessionManager 第4引数に注入しているか。未設定時に no-op「allow-all」で挙動不変か）
7. **ビルド**: baileys 不在で `cd packages/jimmy && tsc --noEmit` が **0 エラー**（コア MIT クリーンの証明）
8. **実機**: Slack で `@番頭` に bob が応答（ログの `Bob engine starting:` の bin が **claude に化けていない**こと）

## 上流を取り込む手順（推奨）
1. `git remote add upstream https://github.com/rsensui2/OpenRyoko` して差分を**ファイル単位でレビュー**。
2. 上表の「独自変更」ファイルは**全面上書きせず差分マージ**（特に `paths.ts` / 3つのエンジン選択三項 / `whatsapp/index.ts`）。
3. マージ後、上のチェックリスト → VM 実機スモークで回帰確認。
