"use client";

import { useCallback, useEffect, useState } from "react";
import { api, pollDaemonHealthy, type McpServerSummary, type PluginEntry, type PluginsSummary } from "@/lib/api";
import { PageLayout } from "@/components/page-layout";
import { useBreadcrumbs } from "@/context/breadcrumb-context";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AlertTriangle, RefreshCw, Power } from "lucide-react";

type PluginType = "engine" | "connector" | "guardrail";

const TYPE_LABEL: Record<PluginType, string> = {
  engine: "エンジン",
  connector: "コネクタ",
  guardrail: "ガードレール",
};

export default function PluginsPage() {
  useBreadcrumbs([{ label: "プラグイン" }]);
  const [data, setData] = useState<PluginsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .getPlugins()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto p-[var(--space-6)]">
        <div className="flex items-center justify-between mb-[var(--space-6)]">
          <div>
            <h2 className="text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)] mb-[var(--space-1)]">
              プラグイン管理
            </h2>
            <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
              エンジン / コネクタ / ガードレールのプラグインを管理します
            </p>
          </div>
          <div className="flex items-center gap-[var(--space-2)]">
            {data?.manageUi && <RestartBantoButton onRecovered={load} />}
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> 再読込
            </Button>
          </div>
        </div>

        {/* Trust warning banner — always visible. */}
        <div
          className="mb-[var(--space-5)] flex gap-3 rounded-[var(--radius-md,12px)] p-[var(--space-4)]"
          style={{
            background: "color-mix(in srgb, var(--system-orange,#f59e0b) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--system-orange,#f59e0b) 35%, transparent)",
          }}
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[var(--system-orange,#f59e0b)]" />
          <div className="text-[length:var(--text-caption1)] leading-relaxed text-[var(--text-secondary)]">
            <strong>プラグインはデーモンと同一権限で任意コードを実行します。</strong>{" "}
            <code>pnpm add</code>{" "}
            はインストール時にパッケージのコードを実行し得ます。信頼できるソース（自社/検証済みパッケージ）のみをインストールしてください。
          </div>
        </div>

        {error && (
          <div
            className="mb-[var(--space-4)] rounded-[var(--radius-md,12px)] py-[var(--space-3)] px-[var(--space-4)] text-[length:var(--text-body)] text-[var(--system-red)]"
            style={{
              background: "color-mix(in srgb, var(--system-red) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)",
            }}
          >
            {error}
          </div>
        )}

        {loading && !data ? (
          <div className="text-center p-[var(--space-8)] text-[var(--text-tertiary)]">Loading...</div>
        ) : data ? (
          <>
            {!data.manageUi && (
              <Card className="mb-[var(--space-5)]">
                <CardContent className="p-[var(--space-5)]">
                  <p className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] mb-[var(--space-2)]">
                    この機能は無効です
                  </p>
                  <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] leading-relaxed">
                    プラグイン管理UIは既定で無効（オプトイン）です。有効化するには{" "}
                    <code>~/.openbanto/config.yaml</code> に以下を追加してデーモンを再起動してください:
                  </p>
                  <pre className="mt-[var(--space-3)] overflow-x-auto rounded-[var(--radius-md,12px)] bg-[var(--bg-tertiary,#111)] p-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-secondary)]">{`plugins:
  manageUi: true
  adminGroup: openbanto-admins`}</pre>
                  <p className="mt-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-quaternary)] leading-relaxed">
                    この機能は Keycloak / oauth2-proxy によるエッジ認証の前段に置き、プロキシが付与する{" "}
                    <code>X-Forwarded-Groups</code> に <code>adminGroup</code>{" "}
                    が含まれる場合のみ操作を許可します（サーバ側で再チェック）。プロキシ無しの場合は localhost からのみ許可されます。
                  </p>
                </CardContent>
              </Card>
            )}

            <Tabs defaultValue="engine">
              <TabsList>
                <TabsTrigger value="engine">エンジン ({data.engines.length})</TabsTrigger>
                <TabsTrigger value="connector">コネクタ ({data.connectors.length})</TabsTrigger>
                <TabsTrigger value="guardrail">ガードレール ({data.guardrails.length})</TabsTrigger>
                <TabsTrigger value="mcp">MCP ({(data.mcpServers ?? []).length})</TabsTrigger>
              </TabsList>

              <TabsContent value="engine">
                <PluginList type="engine" items={data.engines} onChanged={load} />
                {data.manageUi && <OpenAiEngineSection engines={data.engines} onChanged={load} />}
              </TabsContent>
              <TabsContent value="connector">
                <PluginList type="connector" items={data.connectors} onChanged={load} />
              </TabsContent>
              <TabsContent value="guardrail">
                <PluginList type="guardrail" items={data.guardrails} onChanged={load} />
                {data.manageUi && <GuardrailSection current={data.guardrails[0]} onChanged={load} />}
              </TabsContent>
              <TabsContent value="mcp">
                <McpSection servers={data.mcpServers ?? []} canEdit={data.manageUi} onChanged={load} />
              </TabsContent>
            </Tabs>

            {data.manageUi && <AddPluginForm onInstalled={load} />}
          </>
        ) : null}
      </div>
    </PageLayout>
  );
}

/**
 * Admin-only "Banto を再起動" button. Confirm → POST /api/admin/restart → the
 * daemon self-terminates and systemd (Restart=always) brings it back. We then
 * poll /api/status until it responds 200 ("復帰しました") and refresh the page
 * data. During the restart window fetch fails; those errors are swallowed and
 * retried by pollDaemonHealthy.
 */
function RestartBantoButton({ onRecovered }: { onRecovered: () => void }) {
  const [phase, setPhase] = useState<"idle" | "restarting" | "recovered" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  const busy = phase === "restarting";

  const restart = useCallback(async () => {
    if (busy) return;
    const ok = window.confirm(
      "Banto（デーモン）を再起動します。実行中のセッションは中断され、数秒〜十数秒アクセスできなくなります。続行しますか？",
    );
    if (!ok) return;
    setPhase("restarting");
    setMsg(null);
    try {
      const res = await api.restartDaemon();
      // 409 は既に再起動中 — その場合でも復帰を待つ。
      if (res.restarting) {
        const healthy = await pollDaemonHealthy({ timeoutMs: 60_000, intervalMs: 1_500 });
        if (healthy) {
          setPhase("recovered");
          setMsg("復帰しました");
          onRecovered();
          // 少し見せてから状態を戻す。
          setTimeout(() => setPhase("idle"), 4_000);
        } else {
          setPhase("error");
          setMsg("復帰の確認がタイムアウトしました。しばらくして再読込してください。");
        }
      } else {
        setPhase("error");
        setMsg("再起動の受付に失敗しました。");
      }
    } catch (err) {
      setPhase("error");
      setMsg(err instanceof Error ? err.message : "再起動に失敗しました。");
    }
  }, [busy, onRecovered]);

  return (
    <div className="flex items-center gap-[var(--space-2)]">
      {msg && (
        <span
          className="text-[length:var(--text-caption1)]"
          style={{
            color:
              phase === "error"
                ? "var(--system-red)"
                : phase === "recovered"
                ? "var(--system-green,#22c55e)"
                : "var(--text-tertiary)",
          }}
        >
          {msg}
        </span>
      )}
      <Button variant="outline" size="sm" onClick={restart} disabled={busy}>
        <Power size={14} className={busy ? "animate-pulse" : ""} />{" "}
        {busy ? "再起動中…" : "Banto を再起動"}
      </Button>
    </div>
  );
}

function PluginList({
  type,
  items,
  onChanged,
}: {
  type: PluginType;
  items: PluginEntry[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function toggle(entry: PluginEntry, enabled: boolean) {
    setBusy(entry.name);
    setMsg(null);
    try {
      const res = await api.togglePlugin({ pluginType: type, name: entry.name, enabled });
      if (res.needsRestart) setMsg(`${entry.name}: 設定を保存しました。反映にはデーモンの再起動が必要です。`);
      onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return (
      <p className="p-[var(--space-6)] text-center text-[length:var(--text-body)] text-[var(--text-tertiary)]">
        設定済みの{TYPE_LABEL[type]}プラグインはありません
      </p>
    );
  }

  return (
    <div className="mt-[var(--space-4)] flex flex-col gap-[var(--space-3)]">
      {msg && (
        <div className="rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]" style={{ background: "color-mix(in srgb, var(--accent) 8%, transparent)" }}>
          {msg}
        </div>
      )}
      {items.map((entry) => (
        <Card key={entry.name}>
          <CardContent className="flex items-center justify-between gap-4 p-[var(--space-4)]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                  {entry.name}
                </span>
                <Badge variant={entry.kind === "builtin" ? "secondary" : "default"}>
                  {entry.kind === "builtin" ? "組込" : "モジュール"}
                </Badge>
                {entry.hasConfig && <Badge variant="outline">config</Badge>}
              </div>
              {entry.module && (
                <p className="mt-1 truncate text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                  {entry.module}
                </p>
              )}
            </div>
            <label className="flex shrink-0 items-center gap-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              <input
                type="checkbox"
                checked={entry.enabled}
                disabled={busy === entry.name}
                onChange={(e) => toggle(entry, e.target.checked)}
              />
              有効
            </label>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Add / edit OpenAI-compatible engines (impl:"openai"). Type-safe inputs (not
 *  raw JSON). apiKey is write-only: on edit it is left blank and only sent when
 *  the operator re-enters it (empty → keep stored key). */
function OpenAiEngineSection({
  engines,
  onChanged,
}: {
  engines: PluginEntry[];
  onChanged: () => void;
}) {
  const openaiEngines = engines.filter((e) => e.impl === "openai");
  // `editing` holds the engine being edited, or "new" for the add form, or null.
  const [editing, setEditing] = useState<PluginEntry | "new" | null>(null);

  return (
    <div className="mt-[var(--space-6)]">
      <div className="mb-[var(--space-3)] flex items-center justify-between">
        <h3 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          OpenAI 互換エンジン
        </h3>
        {editing === null && (
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
            OpenAI 互換エンジンを追加
          </Button>
        )}
      </div>

      {openaiEngines.length > 0 && (
        <div className="mb-[var(--space-3)] flex flex-col gap-[var(--space-2)]">
          {openaiEngines.map((e) => (
            <Card key={e.name}>
              <CardContent className="flex items-center justify-between gap-4 p-[var(--space-4)]">
                <div className="min-w-0">
                  <span className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                    {e.name}
                  </span>
                  <p className="mt-1 truncate text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                    {e.openai?.baseUrl}
                    {e.openai?.model ? ` · ${e.openai.model}` : ""}
                    {e.openai?.hasApiKey ? " · 🔑 設定済" : " · 🔑 未設定"}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setEditing(e)}>
                  編集
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editing !== null && (
        <OpenAiEngineForm
          entry={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function OpenAiEngineForm({
  entry,
  onClose,
  onSaved,
}: {
  entry: PluginEntry | null; // null = create
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = entry !== null;
  const [name, setName] = useState(entry?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(entry?.openai?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(entry?.openai?.model ?? "");
  const [temperature, setTemperature] = useState(
    entry?.openai?.temperature !== undefined ? String(entry.openai.temperature) : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; needsRestart?: boolean }
    | { kind: "error"; message: string }
    | null
  >(null);

  const inputCls =
    "w-full rounded-[var(--radius-md,12px)] border border-border bg-[var(--bg-secondary)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);

    const nm = name.trim();
    if (!/^[a-z0-9-]+$/.test(nm)) {
      setResult({ kind: "error", message: "名前は [a-z0-9-]+ である必要があります" });
      return;
    }
    if (!/^https?:\/\//.test(baseUrl.trim())) {
      setResult({ kind: "error", message: "baseUrl は http(s):// である必要があります" });
      return;
    }
    let temp: number | undefined;
    if (temperature.trim()) {
      const t = Number(temperature);
      if (!Number.isFinite(t)) {
        setResult({ kind: "error", message: "temperature は数値である必要があります" });
        return;
      }
      temp = t;
    }

    setSubmitting(true);
    try {
      const res = await api.upsertOpenAiEngine({
        name: nm,
        baseUrl: baseUrl.trim(),
        // Only send apiKey when entered; empty on edit keeps the stored key.
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(temp !== undefined ? { temperature: temp } : {}),
      });
      if (res.status === "ok") {
        setResult({ kind: "ok", needsRestart: res.needsRestart });
        setApiKey("");
        onSaved();
      } else {
        setResult({ kind: "error", message: res.message || "保存に失敗しました" });
      }
    } catch (err) {
      setResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-[var(--space-5)]">
        <div className="mb-[var(--space-4)] flex items-center justify-between">
          <h4 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            {isEdit ? `エンジンを編集: ${entry!.name}` : "OpenAI 互換エンジンを追加"}
          </h4>
          <Button variant="ghost" size="sm" onClick={onClose}>
            閉じる
          </Button>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-[var(--space-4)]">
          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              名前 (識別子, [a-z0-9-]+)
            </label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="openai-1"
              disabled={isEdit}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              baseUrl (http(s)://)
            </label>
            <input
              className={inputCls}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://llm.example.internal"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              apiKey{" "}
              {isEdit && (
                <span className="text-[var(--text-quaternary)]">
                  (空欄なら既存キーを維持{entry?.openai?.hasApiKey ? "" : "・現在未設定"})
                </span>
              )}
            </label>
            <input
              className={inputCls}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isEdit ? "（変更する場合のみ入力）" : "sk-..."}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              model (任意)
            </label>
            <input
              className={inputCls}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini"
            />
          </div>
          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              temperature (任意)
            </label>
            <input
              className={inputCls}
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
              placeholder="0.7"
              inputMode="decimal"
            />
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={submitting}>
              {submitting ? "保存中..." : isEdit ? "更新" : "追加"}
            </Button>
            <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
              反映にはデーモンの再起動が必要です
            </span>
          </div>
        </form>

        {result?.kind === "ok" && (
          <div
            className="mt-[var(--space-4)] rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption1)]"
            style={{ background: "color-mix(in srgb, var(--system-green,#22c55e) 12%, transparent)", color: "var(--text-secondary)" }}
          >
            保存しました{result.needsRestart ? "。反映にはデーモンの再起動が必要です。" : "。"}
          </div>
        )}
        {result?.kind === "error" && (
          <div
            className="mt-[var(--space-4)] rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--system-red)]"
            style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)" }}
          >
            {result.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Guardrail policy form (single instance). Selects the policy KIND
 *  (None / Sample built-in / External module) and edits the fields for the
 *  chosen kind. Prefilled from the current `guardrails` summary. The audit
 *  endpoint is write-only: on edit it stays blank and is only sent when re-typed
 *  (server keeps the stored value unless a new one is provided — actually it
 *  rewrites the whole block, so re-enter it if you keep the http sink). */
function GuardrailSection({
  current,
  onChanged,
}: {
  current: PluginEntry | undefined;
  onChanged: () => void;
}) {
  // Derive the initial policy kind from the summary.
  const initialPolicy: "none" | "sample" | "module" = current?.module
    ? "module"
    : current?.impl === "sample"
      ? "sample"
      : "none";

  const [policy, setPolicy] = useState<"none" | "sample" | "module">(initialPolicy);

  // Sample fields (prefilled from summary.sample).
  const s = current?.sample;
  const [allowUsers, setAllowUsers] = useState((s?.allowUsers ?? []).join(", "));
  const [denyKeywords, setDenyKeywords] = useState((s?.denyKeywords ?? []).join(", "));
  const [approvalTools, setApprovalTools] = useState((s?.approvalTools ?? []).join(", "));
  const [approvers, setApprovers] = useState((s?.approvers ?? []).join(", "));
  const [auditSink, setAuditSink] = useState<"log" | "http">(s?.auditSink ?? "log");
  const [auditEndpoint, setAuditEndpoint] = useState("");

  // Module fields.
  const [moduleSpec, setModuleSpec] = useState(current?.module ?? "");
  // Module config isn't surfaced by the summary (may contain secrets) — start blank.
  const [configText, setConfigText] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; needsRestart?: boolean }
    | { kind: "error"; message: string }
    | null
  >(null);

  const inputCls =
    "w-full rounded-[var(--radius-md,12px)] border border-border bg-[var(--bg-secondary)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]";

  const splitCsv = (v: string) =>
    v.split(",").map((x) => x.trim()).filter(Boolean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);

    if (policy === "module" && !moduleSpec.trim()) {
      setResult({ kind: "error", message: "モジュール指定子を入力してください" });
      return;
    }
    let config: Record<string, unknown> | undefined;
    if (policy === "module" && configText.trim()) {
      try {
        config = JSON.parse(configText);
      } catch {
        setResult({ kind: "error", message: "config は有効な JSON である必要があります" });
        return;
      }
    }
    if (policy === "sample" && auditSink === "http" && !/^https?:\/\//.test(auditEndpoint.trim())) {
      setResult({ kind: "error", message: "auditSink=http のときは http(s) の endpoint が必要です" });
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.setGuardrail(
        policy === "sample"
          ? {
              policy: "sample",
              allowUsers: splitCsv(allowUsers),
              denyKeywords: splitCsv(denyKeywords),
              approvalTools: splitCsv(approvalTools),
              approvers: splitCsv(approvers),
              auditSink,
              ...(auditSink === "http" ? { auditEndpoint: auditEndpoint.trim() } : {}),
            }
          : policy === "module"
            ? { policy: "module", module: moduleSpec.trim(), ...(config ? { config } : {}) }
            : { policy: "none" },
      );
      if (res.status === "ok") {
        setResult({ kind: "ok", needsRestart: res.needsRestart });
        setAuditEndpoint("");
        onChanged();
      } else {
        setResult({ kind: "error", message: res.message || "保存に失敗しました" });
      }
    } catch (err) {
      setResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mt-[var(--space-6)]">
      <CardContent className="p-[var(--space-5)]">
        <h3 className="mb-[var(--space-2)] text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          ガードレール ポリシー設定
        </h3>
        {/* Strong-permission warning — a guardrail can STOP turn execution. */}
        <div
          className="mb-[var(--space-4)] flex gap-2 rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-secondary)]"
          style={{
            background: "color-mix(in srgb, var(--system-orange,#f59e0b) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--system-orange,#f59e0b) 30%, transparent)",
          }}
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--system-orange,#f59e0b)]" />
          <span>
            ガードレールは<strong>全ターンの実行を止められる強い権限</strong>を持ちます（deny =
            即ブロック / require_approval = 承認待ち）。ルールは userId / toolbelt / text
            を基準に評価されます（Keycloak groups はターン文脈に含まれません）。
          </span>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-[var(--space-4)]">
          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              ポリシー種別
            </label>
            <select
              value={policy}
              onChange={(e) => setPolicy(e.target.value as "none" | "sample" | "module")}
              className={inputCls}
            >
              <option value="none">None（allow-all / 無効化）</option>
              <option value="sample">Sample（組込みポリシーパック）</option>
              <option value="module">External module（外部プラグイン）</option>
            </select>
          </div>

          {policy === "sample" && (
            <>
              <div>
                <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  allowUsers（常に許可する userId, カンマ区切り）
                </label>
                <input
                  className={inputCls}
                  value={allowUsers}
                  onChange={(e) => setAllowUsers(e.target.value)}
                  placeholder="U012ADMIN, U034OPS"
                />
              </div>
              <div>
                <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  denyKeywords（text に含めば拒否, カンマ区切り）
                </label>
                <input
                  className={inputCls}
                  value={denyKeywords}
                  onChange={(e) => setDenyKeywords(e.target.value)}
                  placeholder="rm -rf /, drop database"
                />
              </div>
              <div>
                <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  approvalTools（toolbelt に含めば承認要求, カンマ区切り）
                </label>
                <input
                  className={inputCls}
                  value={approvalTools}
                  onChange={(e) => setApprovalTools(e.target.value)}
                  placeholder="calendar, ledger"
                />
              </div>
              <div>
                <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  approvers（承認者 userId, カンマ区切り, 任意）
                </label>
                <input
                  className={inputCls}
                  value={approvers}
                  onChange={(e) => setApprovers(e.target.value)}
                  placeholder="U012ADMIN"
                />
              </div>
              <div>
                <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  auditSink
                </label>
                <select
                  value={auditSink}
                  onChange={(e) => setAuditSink(e.target.value as "log" | "http")}
                  className={inputCls}
                >
                  <option value="log">log（logger.info に1行）</option>
                  <option value="http">http（外部監査GWへPOST）</option>
                </select>
              </div>
              {auditSink === "http" && (
                <div>
                  <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                    auditEndpoint（http(s) POST 先）
                    {s?.hasAuditEndpoint && (
                      <span className="text-[var(--text-quaternary)]">
                        {" "}（設定済・保存時は再入力してください）
                      </span>
                    )}
                  </label>
                  <input
                    className={inputCls}
                    value={auditEndpoint}
                    onChange={(e) => setAuditEndpoint(e.target.value)}
                    placeholder="https://llm.example.internal/audit"
                  />
                </div>
              )}
            </>
          )}

          {policy === "module" && (
            <>
              <div>
                <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  モジュール（npm パッケージ名 または git+https://... ）
                </label>
                <input
                  className={inputCls}
                  value={moduleSpec}
                  onChange={(e) => setModuleSpec(e.target.value)}
                  placeholder="@acme/guardrail-policy"
                />
                <p className="mt-1 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
                  ※ 外部モジュールは別途インストールが必要です（この保存は config への配線のみ）。
                </p>
              </div>
              <div>
                <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  config（JSON, 任意）
                </label>
                <textarea
                  className={`${inputCls} font-mono min-h-[100px]`}
                  value={configText}
                  onChange={(e) => setConfigText(e.target.value)}
                  placeholder='{ "blocklist": ["secret"] }'
                />
              </div>
            </>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={submitting}>
              {submitting ? "保存中..." : "保存"}
            </Button>
            <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
              反映にはデーモンの再起動が必要です
            </span>
          </div>
        </form>

        {result?.kind === "ok" && (
          <div
            className="mt-[var(--space-4)] rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption1)]"
            style={{ background: "color-mix(in srgb, var(--system-green,#22c55e) 12%, transparent)", color: "var(--text-secondary)" }}
          >
            保存しました{result.needsRestart ? "。反映にはデーモンの再起動が必要です。" : "。"}
          </div>
        )}
        {result?.kind === "error" && (
          <div
            className="mt-[var(--space-4)] rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--system-red)]"
            style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)" }}
          >
            {result.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AddPluginForm({ onInstalled }: { onInstalled: () => void }) {
  const [pluginType, setPluginType] = useState<PluginType>("guardrail");
  const [name, setName] = useState("");
  const [moduleSpec, setModuleSpec] = useState("");
  const [configText, setConfigText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; needsRestart?: boolean }
    | { kind: "error"; message: string; stderr?: string }
    | null
  >(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);

    let config: Record<string, unknown> | undefined;
    if (configText.trim()) {
      try {
        config = JSON.parse(configText);
      } catch {
        setResult({ kind: "error", message: "config は有効な JSON である必要があります" });
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await api.installPlugin({ pluginType, name: name.trim(), module: moduleSpec.trim(), config });
      if (res.status === "installed") {
        setResult({ kind: "ok", needsRestart: res.needsRestart });
        setName("");
        setModuleSpec("");
        setConfigText("");
        onInstalled();
      } else {
        setResult({ kind: "error", message: res.message || "インストールに失敗しました", stderr: res.stderr });
      }
    } catch (err) {
      setResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls =
    "w-full rounded-[var(--radius-md,12px)] border border-border bg-[var(--bg-secondary)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]";

  return (
    <Card className="mt-[var(--space-6)]">
      <CardContent className="p-[var(--space-5)]">
        <h3 className="mb-[var(--space-4)] text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          プラグインを追加
        </h3>
        <form onSubmit={submit} className="flex flex-col gap-[var(--space-4)]">
          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">種別</label>
            <select
              value={pluginType}
              onChange={(e) => setPluginType(e.target.value as PluginType)}
              className={inputCls}
            >
              <option value="engine">エンジン</option>
              <option value="connector">コネクタ</option>
              <option value="guardrail">ガードレール</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              名前 (engine 名 / connector id / guardrail は任意)
            </label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-guardrail"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              モジュール (npm パッケージ名 または git+https://... )
            </label>
            <input
              className={inputCls}
              value={moduleSpec}
              onChange={(e) => setModuleSpec(e.target.value)}
              placeholder="@openbanto/my-guardrail  または  git+https://github.com/acme/plugin.git"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              config (JSON, 任意)
            </label>
            <textarea
              className={`${inputCls} font-mono min-h-[100px]`}
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
              placeholder='{ "blocklist": ["rm -rf"] }'
            />
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={submitting}>
              {submitting ? "インストール中..." : "インストール"}
            </Button>
            <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
              コネクタは即時反映、エンジン/ガードレールは再起動が必要です
            </span>
          </div>
        </form>

        {result?.kind === "ok" && (
          <div
            className="mt-[var(--space-4)] rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption1)]"
            style={{ background: "color-mix(in srgb, var(--system-green,#22c55e) 12%, transparent)", color: "var(--text-secondary)" }}
          >
            インストール成功{result.needsRestart ? "。反映にはデーモンの再起動が必要です。" : "（即時反映されました）。"}
          </div>
        )}
        {result?.kind === "error" && (
          <div
            className="mt-[var(--space-4)] rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--system-red)]"
            style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)" }}
          >
            {result.message}
            {result.stderr && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[length:var(--text-caption2)]">
                {result.stderr}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const KV_INPUT_CLS =
  "w-full rounded-[var(--radius-md,12px)] border border-border bg-[var(--bg-secondary)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]";

/** Editable list of key→value pairs where the VALUE is a secret (password
 *  field). On edit, a stored secret is represented by a blank value with the
 *  "設定済" hint; leaving it blank preserves the server-side value. */
type KvPair = { key: string; value: string; hadSecret: boolean };

function SecretKvEditor({
  label,
  hint,
  pairs,
  onChange,
}: {
  label: string;
  hint?: string;
  pairs: KvPair[];
  onChange: (pairs: KvPair[]) => void;
}) {
  const update = (i: number, patch: Partial<KvPair>) =>
    onChange(pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const add = () => onChange([...pairs, { key: "", value: "", hadSecret: false }]);
  const remove = (i: number) => onChange(pairs.filter((_, idx) => idx !== i));

  return (
    <div>
      <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        {label}
        {hint && <span className="text-[var(--text-quaternary)]"> {hint}</span>}
      </label>
      <div className="flex flex-col gap-[var(--space-2)]">
        {pairs.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={KV_INPUT_CLS}
              value={p.key}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder="KEY"
              autoComplete="off"
            />
            <input
              className={KV_INPUT_CLS}
              type="password"
              value={p.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={p.hadSecret ? "（設定済・変更時のみ入力）" : "value"}
              autoComplete="new-password"
            />
            <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>
              削除
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={add}>
          + 行を追加
        </Button>
      </div>
    </div>
  );
}

/** MCP servers (職人/tools) list + add/edit form. Consumed per-turn by the
 *  engine, so changes reflect on the NEXT turn (no restart). */
function McpSection({
  servers,
  canEdit,
  onChanged,
}: {
  servers: McpServerSummary[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<McpServerSummary | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function toggle(s: McpServerSummary, enabled: boolean) {
    setBusy(s.name);
    setMsg(null);
    try {
      // enabled toggle rides on the upsert endpoint; secrets are preserved
      // server-side (we send no header/env values, so blanks keep the stored).
      await api.upsertMcpServer({ name: s.name, transport: s.transport, enabled });
      onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(s: McpServerSummary) {
    if (!window.confirm(`MCP サーバ "${s.name}" を削除しますか？`)) return;
    setBusy(s.name);
    setMsg(null);
    try {
      await api.deleteMcpServer(s.name);
      onChanged();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-[var(--space-4)]">
      {/* Trust warning — MCP servers hand external TOOLS to the agent. */}
      <div
        className="mb-[var(--space-4)] flex gap-2 rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-secondary)]"
        style={{
          background: "color-mix(in srgb, var(--system-orange,#f59e0b) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--system-orange,#f59e0b) 30%, transparent)",
        }}
      >
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--system-orange,#f59e0b)]" />
        <span>
          MCP サーバは<strong>外部ツールをエージェントに与えます</strong>。stdio
          はローカルで子プロセス（command）を起動し、URL は外部エンドポイントを呼びます。信頼できるサーバのみを登録してください。
        </span>
      </div>

      {/* Engine-support hint — which engine actually CONSUMES MCP tools. */}
      <div
        className="mb-[var(--space-4)] rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption2)] text-[var(--text-secondary)]"
        style={{ background: "color-mix(in srgb, var(--accent) 8%, transparent)" }}
      >
        MCP ツールを呼ぶのは<strong>エンジン</strong>です。現状 <code>claude</code> エンジンが
        stdio / HTTP(SSE) MCP を消費します。<code>bob</code> は非対応、{" "}
        <code>impl: &quot;openai&quot;</code> 系（OpenAI 互換）エンジンは tool-call 実装後に対応します。
      </div>

      {msg && (
        <div
          className="mb-[var(--space-3)] rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--system-red)]"
          style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)" }}
        >
          {msg}
        </div>
      )}

      <div className="mb-[var(--space-3)] flex items-center justify-between">
        <h3 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          MCP サーバ（職人 / tools）
        </h3>
        {canEdit && editing === null && (
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
            MCP サーバを追加
          </Button>
        )}
      </div>

      {servers.length === 0 ? (
        <p className="p-[var(--space-6)] text-center text-[length:var(--text-body)] text-[var(--text-tertiary)]">
          登録済みの MCP サーバはありません
        </p>
      ) : (
        <div className="flex flex-col gap-[var(--space-2)]">
          {servers.map((s) => (
            <Card key={s.name}>
              <CardContent className="flex items-center justify-between gap-4 p-[var(--space-4)]">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                      {s.name}
                    </span>
                    <Badge variant="secondary">{s.transport === "url" ? "URL(SSE)" : "stdio"}</Badge>
                    {s.hasHeaders && <Badge variant="outline">headers 設定済</Badge>}
                    {s.hasEnv && <Badge variant="outline">env 設定済</Badge>}
                  </div>
                  <p className="mt-1 truncate text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                    {s.transport === "url" ? s.url : s.command}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <label className="flex items-center gap-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={!canEdit || busy === s.name}
                      onChange={(e) => toggle(s, e.target.checked)}
                    />
                    有効
                  </label>
                  {canEdit && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setEditing(s)}>
                        編集
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => remove(s)} disabled={busy === s.name}>
                        削除
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {canEdit && editing !== null && (
        <div className="mt-[var(--space-4)]">
          <McpServerForm
            entry={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              onChanged();
            }}
          />
        </div>
      )}
    </div>
  );
}

function McpServerForm({
  entry,
  onClose,
  onSaved,
}: {
  entry: McpServerSummary | null; // null = create
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = entry !== null;
  const [name, setName] = useState(entry?.name ?? "");
  const [transport, setTransport] = useState<"url" | "stdio">(entry?.transport ?? "url");
  const [enabled, setEnabled] = useState(entry?.enabled ?? true);
  // URL transport
  const [url, setUrl] = useState(entry?.url ?? "");
  // On edit, seed one blank "設定済" header row so the operator sees the secret
  // exists; leaving it blank preserves it. The key isn't surfaced by the
  // summary, so headers are re-entered by key on edit.
  const [headers, setHeaders] = useState<KvPair[]>(
    entry?.hasHeaders ? [{ key: "", value: "", hadSecret: true }] : [],
  );
  // stdio transport
  const [command, setCommand] = useState(entry?.command ?? "");
  const [argsText, setArgsText] = useState("");
  const [env, setEnv] = useState<KvPair[]>(
    entry?.hasEnv ? [{ key: "", value: "", hadSecret: true }] : [],
  );

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" } | { kind: "error"; message: string } | null>(null);

  const inputCls = KV_INPUT_CLS;

  function kvToObject(pairs: KvPair[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of pairs) {
      const k = p.key.trim();
      if (!k) continue;
      out[k] = p.value; // blank value → server preserves stored secret
    }
    return out;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);

    const nm = name.trim();
    if (!/^[a-z0-9-]+$/.test(nm)) {
      setResult({ kind: "error", message: "名前は [a-z0-9-]+ である必要があります" });
      return;
    }
    if (transport === "url" && !/^https?:\/\//.test(url.trim())) {
      setResult({ kind: "error", message: "url は http(s):// である必要があります" });
      return;
    }
    if (transport === "stdio" && !command.trim()) {
      setResult({ kind: "error", message: "stdio は command が必須です" });
      return;
    }

    // Split args on newline or comma.
    const args = argsText
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean);

    setSubmitting(true);
    try {
      const res = await api.upsertMcpServer(
        transport === "url"
          ? {
              name: nm,
              transport: "url",
              enabled,
              url: url.trim(),
              headers: kvToObject(headers),
            }
          : {
              name: nm,
              transport: "stdio",
              enabled,
              command: command.trim(),
              ...(args.length ? { args } : {}),
              env: kvToObject(env),
            },
      );
      if (res.status === "ok") {
        setResult({ kind: "ok" });
        onSaved();
      } else {
        setResult({ kind: "error", message: res.message || "保存に失敗しました" });
      }
    } catch (err) {
      setResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-[var(--space-5)]">
        <div className="mb-[var(--space-4)] flex items-center justify-between">
          <h4 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            {isEdit ? `MCP サーバを編集: ${entry!.name}` : "MCP サーバを追加"}
          </h4>
          <Button variant="ghost" size="sm" onClick={onClose}>
            閉じる
          </Button>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-[var(--space-4)]">
          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              名前 (識別子, [a-z0-9-]+)
            </label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-tools"
              disabled={isEdit}
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
              トランスポート
            </label>
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value as "url" | "stdio")}
              className={inputCls}
              disabled={isEdit}
            >
              <option value="url">URL（HTTP / SSE リモート）</option>
              <option value="stdio">stdio（ローカル子プロセス）</option>
            </select>
          </div>

          {transport === "url" ? (
            <>
              <div>
                <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  url (http(s)://)
                </label>
                <input
                  className={inputCls}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.example.com/sse"
                  required
                />
              </div>
              <SecretKvEditor
                label="headers（認証ヘッダ, 値は秘匿）"
                hint={entry?.hasHeaders ? "（設定済・空欄なら維持）" : undefined}
                pairs={headers}
                onChange={setHeaders}
              />
            </>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  command
                </label>
                <input
                  className={inputCls}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  args（カンマ または 改行区切り, 任意）
                </label>
                <textarea
                  className={`${inputCls} font-mono min-h-[72px]`}
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder={"-y\n@acme/mcp-server"}
                />
              </div>
              <SecretKvEditor
                label="env（環境変数, 値は秘匿）"
                hint={entry?.hasEnv ? "（設定済・空欄なら維持）" : undefined}
                pairs={env}
                onChange={setEnv}
              />
            </>
          )}

          <label className="flex items-center gap-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            有効
          </label>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={submitting}>
              {submitting ? "保存中..." : isEdit ? "更新" : "追加"}
            </Button>
            <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
              次のターンから反映されます（再起動不要）
            </span>
          </div>
        </form>

        {result?.kind === "ok" && (
          <div
            className="mt-[var(--space-4)] rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption1)]"
            style={{ background: "color-mix(in srgb, var(--system-green,#22c55e) 12%, transparent)", color: "var(--text-secondary)" }}
          >
            保存しました。次のターンから反映されます。
          </div>
        )}
        {result?.kind === "error" && (
          <div
            className="mt-[var(--space-4)] rounded-[var(--radius-md,12px)] p-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--system-red)]"
            style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)" }}
          >
            {result.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
