# 上流 OpenRyoko 未取り込みバックログ

OpenBanto は **2026-08-09 に OpenRyoko 2026.8.5 相当のスナップショット**から出発した(履歴非共有)。
本書は本家 `rsensui2/OpenRyoko` のそれ以降(2026.8.17〜2026.9.8、約90コミット)の**未移植分の棚卸し**。
衝突リスクは各コミットの変更ファイルを [BANTO-PORT-PLAN.md](./BANTO-PORT-PLAN.md) の独自変更ファイル群と機械照合した結果。
週次の新着は「OpenRyoko上流ウォッチ」ルーチンが Slack DM で通知する — 本書は初期在庫、以後の増分はルーチン側。

最終棚卸し: 2026-09-14(上流 2026.9.8 = 9f18453 時点)

## 優先度P1 — 小さく効く(すぐ取り込み推奨)

| 上流コミット | 内容 | 価値 | 衝突リスク |
|---|---|---|---|
| c00e8a9 / fabd8e9 / b814a06 / 726e493 (2026.9.3) | **委譲プロトコル改善**(完了通知の配送に依存しない設計へ)+自ゲートウェイ通知の401修正 | **高** — gwbanto実運用で起きた「二重委任」「委譲結果が届かない」問題の上流解 | 中(context.ts) |
| 1b338a3 | respondTo.channel=mention/never 時にチャンネルのリアクションを処理しない | 中 — gwbantoはmentionゲート運用 | 中(slack/index.ts) |
| 67d4b9d | detached job 通知の認証 | 中(セキュリティ小) | 低 |
| 1290dcb / a473f53 / 5979004 | シェルインジェクション修正・win32 spawn引数検証・日本語検索のUnicode修正 | 中(セキュリティ/日本語) | 中(context.ts 1件) |
| 093188c | Slack ID-only 添付の hydrate(画像取得の信頼性) | 中 — 名刺係/receipt系に関係 | 中(slack/format.ts, index.ts) |

## 優先度P2 — 大きく効く(スプリント単位で計画取り込み)

| 上流コミット群 | 内容 | 価値 | 衝突リスク |
|---|---|---|---|
| 600fa0e + d95bacd (2026.8.17) | **Jinn信頼性スイート統合 + モデル制御**(74ファイル) | 高(安定性の底上げ) | **HIGH**(api/server/manager/paths/types = 独自変更の中心) |
| 5a274eb / bd48915 / ef2bb6f (2026.8.18) | **gateway セキュリティ強化**・依存更新・ダッシュボード/AI更新通知・wildcard self-connect修正 | 高(セキュリティ) | **HIGH**(api/server/types) |
| a86e692 / 5d19964 / 2aa85e8 (+migrations 2026.8.28) | **MEMORY.md 信頼話者ゲート注入 + portal.operatorSlackId 厳密本人確認** | 高 — マルチユーザSlackでのオペレータ誤認・注入対策(gwbantoに直結) | **HIGH**(context/types/api) |
| 2c5a1f8 / 6b9990c / 87717c4 / a726da7 (2026.9.6-9.8) | モデル対応(GPT-6 Astra / Claude Fable 5.1)・workflow max effort保持・digest抑制修正 | 中(将来のエンジン更新に有用) | 中(models/types/context) |

## 優先度P3 — 様子見(需要が出たら)

| 上流コミット群 | 内容 | 判断保留の理由 |
|---|---|---|
| 8dc6b0e 系 (2026.8.29, **130ファイル**) | **Workflow基盤**(上流Jinn移植・オプトイン) | 大型。自動化ハブとセットで価値判断。取り込むなら専用スプリント+チェックリスト全走 |
| 73333c8 系 (2026.8.31) | **自動化ハブ**(cron+workflow統合UI・テンプレ・CLI) | Workflow基盤が前提。cron多用しているので将来性はある |
| 88bddc0 系 (2026.9.1) | オンボーディングウィザードPhase B(初回セットアップを「動くところまで」) | 社内は構築済み。OSS配布強化するなら価値 |
| 59f98a8 / 060f742 / 9c0e309 / d695ac0 (2026.8.27) | 新規セットアップ体験の修復(テンプレ/skills.json/日本語テンプレ) | 同上(P1のセキュリティ3件はここから分離済み) |

## 不要(現時点)

| 上流コミット群 | 内容 | 理由 |
|---|---|---|
| ec5de84〜766e9a0 (2026.9.4-9.5) | Discord respondTo ゲート・replyStyle・Discordオペレータ本人確認 | Discord未使用。使い始めたらP2相当 |
| 79d9cc8 / f4bac5d / 2273f8d / 6f52f43 / 2e02394 | node-pty spawn-helper 権限・npmパッケージング・http向けpolyfill | npm配布経路の修正。社内はgit配置運用 |
| 3704395 | agents-canvas の free_team エラー処理 | Canvas未使用 |

## 取り込み時の手順(共通)

1. `git remote add canonical https://github.com/rsensui2/OpenRyoko.git`(bastion設定済)
2. 対象コミットを `git show canonical <sha>` でレビュー → **cherry-pickせずファイル単位で差分マージ**(履歴非共有のため)
3. HIGH リスク(独自変更ファイル接触)のものは [BANTO-PORT-PLAN.md](./BANTO-PORT-PLAN.md) のチェックリスト(1〜8, 6b〜6i)を全走
4. `pnpm -F jimmy test`(vitest全緑)+ 実機スモーク後にデプロイ
