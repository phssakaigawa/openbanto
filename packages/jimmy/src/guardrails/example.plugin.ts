// Example guardrail — the FIRST OpenBanto guardrail expressed as a plugin, and
// the reference for what a real policy pack looks like. It proves the guardrail
// mechanism end-to-end ("plugin as a plugin"): resolved through the SAME loader
// as an external policy pack (resolveGuardrail), built via defineGuardrailPlugin.
//
// Policy:
//   - beforeTurn: if the inbound text contains any configured blocklist word,
//     DENY with a reason (shown to the user); otherwise ALLOW.
//   - afterTurn: emit a single-line audit record via logger.info.
//
// Config shape (guardrails.config):
//   { blocklist: string[] }   // case-insensitive substring match
//
// See docs/design/guardrails-hooks.md and the BANTO-PORT-PLAN §H.
import { defineGuardrailPlugin } from "./registry.js";

export default defineGuardrailPlugin({
  name: "example",
  create(cfg, ctx) {
    const blocklist = (Array.isArray(cfg.blocklist) ? (cfg.blocklist as unknown[]) : [])
      .filter((w): w is string => typeof w === "string")
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 0);

    return {
      beforeTurn(c) {
        const text = (c.text ?? "").toLowerCase();
        const hit = blocklist.find((w) => text.includes(w));
        if (hit) {
          return { action: "deny", reason: `Blocked term: "${hit}"` };
        }
        return { action: "allow" };
      },
      afterTurn(c, result) {
        ctx.logger.info(
          `[guardrail:example audit] session=${c.sessionKey} connector=${c.connector} ` +
            `channel=${c.channel} user=${c.userId} engine=${c.engine} ` +
            `ok=${result.ok} cost=${result.cost ?? 0} tokens=${result.tokens ?? 0}` +
            (result.error ? ` error=${JSON.stringify(result.error)}` : ""),
        );
      },
    };
  },
});
