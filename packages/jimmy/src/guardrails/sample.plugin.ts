// Sample guardrail POLICY PACK — a config-driven, built-in reference policy that
// operators can turn on WITHOUT installing an external module, the guardrail
// counterpart of the built-in `impl:"openai"` engine (engines/openai.plugin.ts).
//
// It is resolved by the registry when `guardrails.impl === "sample"` (see
// resolveGuardrail / IMPL_PLUGINS), and its behaviour is entirely driven by the
// `guardrails.config` block, so the Web form can compose a real policy from a few
// text inputs. This is deliberately small and readable: a starting TEMPLATE that
// a production policy pack extends, not a finished permission model.
//
// ── Identity note (READ THIS before extending) ──────────────────────────────
// `GuardrailContext` on a Slack (LINE WORKS / Chatwork …) turn carries
// sessionKey/connector/channel/userId/userName/employee?/engine/text/toolbelt.
// It does NOT carry Keycloak groups — connector identity is the per-turn context,
// not an SSO group set. So every rule here keys off `userId` (stable connector
// id), `userName`, `toolbelt` and `text`. A production pack that wants group- or
// role-based policy must resolve the identity itself (e.g. map userId → org role
// via config or a lookup) — this sample stays on what the turn context provides.
//
// Config shape (guardrails.config):
//   {
//     allowUsers: string[],                       // userIds that bypass all rules
//     deny: [{ contains: string[], reason }],     // text substring → deny
//     requireApproval: [{ tools: string[], approvers?, reason? }], // toolbelt ∩ tools → approval
//     audit: { sink: "log" | "http", endpoint?, headers? }        // afterTurn sink
//   }
//
// See docs/design/guardrails-hooks.md and BANTO-PORT-PLAN §K.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { defineGuardrailPlugin } from "./registry.js";
import type { GuardrailContext, GuardrailTurnResult } from "./registry.js";

// ---- Config normalisation --------------------------------------------------

interface DenyRule {
  contains: string[]; // lower-cased substrings
  reason: string;
}
interface ApprovalRule {
  tools: string[];
  approvers?: string[];
  reason?: string;
}
interface AuditCfg {
  sink: "log" | "http";
  endpoint?: string;
  headers?: Record<string, string>;
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function normalizeDeny(v: unknown): DenyRule[] {
  if (!Array.isArray(v)) return [];
  const out: DenyRule[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const contains = toStringArray(r.contains)
      .map((s) => s.toLowerCase())
      .filter((s) => s.length > 0);
    if (contains.length === 0) continue;
    out.push({ contains, reason: typeof r.reason === "string" ? r.reason : "この操作はブロックされました" });
  }
  return out;
}

function normalizeApproval(v: unknown): ApprovalRule[] {
  if (!Array.isArray(v)) return [];
  const out: ApprovalRule[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const tools = toStringArray(r.tools).filter((t) => t.length > 0);
    if (tools.length === 0) continue;
    out.push({
      tools,
      approvers: toStringArray(r.approvers),
      reason: typeof r.reason === "string" ? r.reason : undefined,
    });
  }
  return out;
}

function normalizeAudit(v: unknown): AuditCfg {
  if (!v || typeof v !== "object") return { sink: "log" };
  const r = v as Record<string, unknown>;
  const sink = r.sink === "http" ? "http" : "log";
  return {
    sink,
    endpoint: typeof r.endpoint === "string" ? r.endpoint : undefined,
    headers:
      r.headers && typeof r.headers === "object" && !Array.isArray(r.headers)
        ? (r.headers as Record<string, string>)
        : undefined,
  };
}

export default defineGuardrailPlugin({
  name: "sample",
  create(cfg, ctx) {
    const c = (cfg ?? {}) as Record<string, unknown>;
    const allowUsers = new Set(toStringArray(c.allowUsers));
    const denyRules = normalizeDeny(c.deny);
    const approvalRules = normalizeApproval(c.requireApproval);
    const audit = normalizeAudit(c.audit);

    return {
      // beforeTurn decides allow / deny / require_approval in a fixed order:
      //   1. allowUsers  → allow (privileged users skip every remaining rule)
      //   2. deny        → deny  (text contains any configured substring)
      //   3. requireApproval → require_approval (toolbelt intersects a rule's tools)
      //   4. otherwise   → allow (safe-by-default: no config ⇒ allow-all)
      beforeTurn(t: GuardrailContext) {
        // (1) Privileged userIds bypass all rules.
        if (t.userId && allowUsers.has(t.userId)) {
          return { action: "allow" as const };
        }

        // (2) Deny on dangerous text (case-insensitive substring match).
        const text = (t.text ?? "").toLowerCase();
        for (const rule of denyRules) {
          if (rule.contains.some((needle) => text.includes(needle))) {
            return { action: "deny" as const, reason: rule.reason };
          }
        }

        // (3) Require approval when this turn's toolbelt intersects a rule's tools
        //     (write-capable tools like calendar/ledger).
        const belt = new Set(t.toolbelt ?? []);
        for (const rule of approvalRules) {
          if (rule.tools.some((tool) => belt.has(tool))) {
            return {
              action: "require_approval" as const,
              approvers: rule.approvers,
              reason: rule.reason ?? "この操作には承認が必要です",
            };
          }
        }

        // (4) Default allow.
        return { action: "allow" as const };
      },

      // afterTurn emits ONE structured audit record. Secrets (audit.endpoint,
      // any auth header) and the turn's raw `text` are never included in the
      // record; the http sink is best-effort and NEVER throws.
      async afterTurn(t: GuardrailContext, result: GuardrailTurnResult) {
        const record = {
          ts: new Date().toISOString(),
          who: t.userName || t.userId || "unknown",
          connector: t.connector,
          channel: t.channel,
          engine: t.engine,
          ok: result.ok,
          cost: result.cost ?? 0,
          tokens: result.tokens ?? 0,
          ...(result.error ? { error: result.error } : {}),
        };

        if (audit.sink === "http" && audit.endpoint) {
          // Best-effort POST to an external audit gateway (kannon etc.). Any
          // failure is swallowed — a flaky audit sink must never break a turn.
          // The endpoint/headers are NOT logged.
          try {
            await fetch(audit.endpoint, {
              method: "POST",
              headers: { "content-type": "application/json", ...(audit.headers ?? {}) },
              body: JSON.stringify(record),
            });
          } catch {
            ctx.logger.warn("[guardrail-audit] http sink failed (swallowed)");
          }
          return;
        }

        // Default "log" sink: one JSON line via the shared logger.
        ctx.logger.info("[guardrail-audit] " + JSON.stringify(record));
      },
    };
  },
});
