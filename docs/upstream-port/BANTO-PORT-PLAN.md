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
| **★エンジン設定選択の bob 分岐（最重要）** | `sessions/manager.ts`（~437）/ `gateway/api.ts`（~2369）/ `sessions/context.ts`（`buildDelegationProtocol` ~889）の三項演算子 | **bob 分岐が消えると `bin` が claude にフォールバックして起動失敗**（実際に踏んだバグ）。上流がこの三項を refactor したら**必ず bob 分岐を再適用** |
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

---

## 上流マージ時のチェックリスト（デグレ防止）
1. `engines/bob.ts` が残っているか
2. **★エンジン設定選択の3三項に `bob` 分岐があるか**（`manager.ts` / `api.ts` / `context.ts`）← 最優先
3. `oneShotCli.ts` / `server.ts` / `types.ts` の bob 配線
4. `paths.ts` の `~/.openbanto` 既定 + 自動 migration（全面上書きされていないか）
5. `whatsapp/index.ts` が dynamic import のまま / `package.json` の baileys が optional peer のまま
6. `context.ts` の番頭 identity + 「ご記帳」ONBOARDING
7. **ビルド**: baileys 不在で `cd packages/jimmy && tsc --noEmit` が **0 エラー**（コア MIT クリーンの証明）
8. **実機**: Slack で `@番頭` に bob が応答（ログの `Bob engine starting:` の bin が **claude に化けていない**こと）

## 上流を取り込む手順（推奨）
1. `git remote add upstream https://github.com/rsensui2/OpenRyoko` して差分を**ファイル単位でレビュー**。
2. 上表の「独自変更」ファイルは**全面上書きせず差分マージ**（特に `paths.ts` / 3つのエンジン選択三項 / `whatsapp/index.ts`）。
3. マージ後、上のチェックリスト → VM 実機スモークで回帰確認。
