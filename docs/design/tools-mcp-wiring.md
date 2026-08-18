# Handoff: skills (calendar / minutes / 📌ledger) as MCP tools — no core fork

Status: **handoff reference** for a tools developer. Assistant "skills" — calendar
auto-register, meeting minutes (transcribe→summary→store), 📌pin-to-ledger — attach
as **MCP servers**. OpenBanto already wires MCP per turn, so you add tools by
**config + your own MCP server**, not by editing the core.

## How the core already wires tools

`sessions/manager.ts` builds the per-turn tool set before every `engine.run()`:

```
resolveMcpServers(this.config.mcp, employee, {...})   // manager.ts:441
  → writeMcpConfigFile(mcpConfig, session.id)          // manager.ts:447
  → mcpConfigPath                                       // passed into engine.run (manager.ts:561)
```

- `config.mcp` (`McpGlobalConfig`, `shared/types.ts:619`) is the **global registry
  of MCP servers**.
- `employee.mcp` (`Employee.mcp?: boolean | string[]`, `types.ts:234`) selects
  **which** servers that employee (assistant persona) may use — `true` = all, or an
  allow-list of server names.
- The engine receives `mcpConfigPath` and calls the tools. The `claude` engine
  and the built-in `impl:"openai"` HTTP engines both do this today (bob does not).

So a skill = **one MCP server** registered in `config.mcp`, enabled on the
assistant employee via `employee.mcp`.

## Add a skill (example: calendar)

1. Implement an MCP server (stdio or the shape `resolveMcpServers` expects) that
   exposes tools, e.g. `calendar.create_event({title, startsAt, attendees})`.
   The natural-language date/time extraction ("tomorrow 15:00 meeting with Acme"
   → ISO) happens in the model turn; the tool just performs the write.
2. Register it in the host config — **no core change**:

```yaml
mcp:
  servers:
    calendar:
      command: "node"
      args: ["/opt/skills/calendar-mcp.js"]
      # env: { ...calendar creds... }   # creds live in the server, not the core
    minutes:
      command: "node"
      args: ["/opt/skills/minutes-mcp.js"]   # transcribe→summary→store
    ledger:
      command: "node"
      args: ["/opt/skills/ledger-mcp.js"]     # 📌 pin → append to ledger

employees:
  assistant:
    persona: "A front-of-house concierge; welcomes, delegates heavy work to the engine."
    engine: myllm            # or bob
    mcp: ["calendar", "minutes", "ledger"]   # this assistant's toolbelt
```

## Multiple assistants (per-project)

`Employee` carries `persona` + `engine` + `mcp`, so different assistants = different
personas with different toolbelts, all in one workspace. Route a channel/employee
to a project-specific assistant with a narrower `mcp` allow-list. This is the
"per-project assistant" path — again config-only.

## 📌 pin → ledger specifics

The Slack connector already emits `reaction_added` (subscribe to it in the app;
`connectors/slack/index.ts` derives `slack:reaction:<ch>:<ts>`). Two options:

- **Tool path (preferred):** a normal message turn invokes the `ledger` MCP tool
  to append the pinned message — keeps the write inside the guarded turn (audit,
  permissions apply).
- **Direct path:** handle the reaction event → call the ledger store directly.
  Faster but bypasses guardrails; only for low-risk appends.

## Boundary

- Skill creds (calendar, storage, transcription endpoint) live **in the MCP
  server**, never in the core config beyond the `command/args/env` that launches
  it.
- The core side owns `resolveMcpServers` / `mcpConfigPath` wiring; if a richer
  selection (per-channel, per-user toolbelts) is needed, that is a core change —
  request it rather than forking.
- "Auto importance-marking" (a triage extension) is a model+prompt concern, not a
  tool — coordinate the triage prompt with the core side.

## Registering MCP servers from the Web UI

The Plugins page (`/plugins`, **MCP** tab) can create/update/delete custom MCP
servers (`config.mcp.custom.<name>`) without hand-editing YAML. The tab is gated
by the same `requirePluginAdmin` (feature flag `plugins.manageUi: true` +
`adminGroup` via `X-Forwarded-Groups`, or a loopback connection) as the rest of
the plugin admin surface. Every mutation is audited (`mcp.upsert` / `mcp.delete`,
recording only `name` + `transport` — never a secret value).

### Endpoints (gateway)

- `GET /api/plugins` → the summary now includes `mcpServers[]`, each entry
  **masked**: `{ name, transport:"stdio"|"url", enabled, url? , command?,
  hasHeaders, hasEnv }`. Header/env values and any URL-embedded token are never
  returned — only the boolean presence.
- `POST /api/plugins/mcp` — upsert. Body:
  `{ name, transport, enabled?, url?, headers?, type?, command?, args?, env? }`.
  - `name` must match `[a-z0-9-]+`. URL transport requires an `http(s)` `url`
    (stored with `type: "sse"` as Claude Code requires); stdio transport requires
    a non-empty `command`.
  - **Secrets are write-only.** On an EDIT, a blank header/env value **preserves**
    the stored value (a non-empty value overwrites it, an omitted key drops it).
    Values are never echoed in the response or the audit record.
  - `enabled` rides on the same endpoint; only `enabled: false` is written to
    YAML (absent = enabled).
- `DELETE /api/plugins/mcp?name=…` (or `POST` with `action:"delete"`) — remove.

### Transports

- **URL (HTTP / SSE remote):** `url` + `headers` (auth). Stored as
  `{ type:"sse", url, headers }`. Put credentials in `headers`, not the URL.
- **stdio (local child process):** `command` + `args` (comma/newline split in the
  form) + `env`. `env` values may use `${VAR}` to defer to a process env var.

### enabled / reload behaviour (no restart)

MCP servers are resolved **per-turn** by `resolveMcpServers(config.mcp, …)`
(`mcp/resolver.ts`), which already skips any entry with `enabled: false`. Because
the daemon's chokidar config watcher reloads `config.yaml` and calls
`sessionManager.setConfig(...)`, a write from this form is picked up on the **next
turn** — the endpoint returns `needsRestart: false`. No daemon restart is needed
to add, edit, toggle, or remove an MCP server.

### Built-in `knowledge` server (per-user file IO)

`resolveMcpServers` also injects a built-in **`knowledge`** stdio server
(`mcp/knowledge-server.ts`, compiled to `dist/src/mcp/knowledge-server.js`) —
the same wiring shape as the built-in `gateway` server. It is **enabled by
default**; set `mcp.knowledge.enabled: false` to opt out (`McpGlobalConfig.knowledge`).

It exposes three tools, all confined to `~/.openbanto/knowledge/`:

- `read_knowledge({ path })` — read a knowledge-root-relative file.
- `write_knowledge({ path, content })` — create/overwrite (parent dirs auto-created).
- `list_knowledge({ dir? })` — list a directory (names + sizes).

`path`/`dir` are **root-relative only**. Absolute paths, `~`, `..` traversal,
and symlinks whose real target escapes the root are rejected (`path.resolve`
prefix check + `realpathSync` on the deepest existing ancestor). Error messages
never echo the internal absolute path.

**Why it exists**: the OpenAI-compatible engine has **no native filesystem
access** — it can only touch files through MCP. This server is how it persists
per-user knowledge (`users/<userKey>/profile.md`, `preferences.md`). The `claude`
engine may use it too, or its native Read/Write — so the context's recording
instructions (`sessions/context.ts` → `buildEvolutionContext`) are written
engine-agnostically ("`write_knowledge` … or a direct file write"). See
`docs/design/per-user-knowledge.md` for the per-user scoping model.

### Which engine consumes MCP tools

MCP tools are invoked by the **engine**, not the connector. Today the `claude`
engine **and the built-in OpenAI-compatible `impl:"openai"` engines**
(OpenAI-compatible engines) consume MCP servers — both stdio and URL (SSE / streamable
HTTP) transports. The OpenAI engine reads `opts.mcpConfigPath`, connects an MCP
client per server via `@modelcontextprotocol/sdk`, advertises each server's tools
to the model as OpenAI `tools` namespaced `"<server>__<tool>"`, and runs a bounded
non-streaming tool-call loop (POST → run `tool_calls` via MCP → feed results back
as `{role:"tool"}` messages) until the model returns a final answer. See
`engines/openai.ts` + `mcp/tool-bridge.ts`. `bob` does not support MCP. The UI
surfaces this as a hint so operators do not expect a registered server to take
effect under an engine that cannot call it.

### Per-turn identity propagation (番頭ID伝播)

`resolveMcpServers(globalMcp, employee, sessionContext)` also stamps the **current
speaker's identity** into **every** resolved MCP server, so each 職人 (shokunin)
can scope its persistent I/O per-user. `McpSessionContext` carries `userId`
(connector-native, e.g. Slack `U…`), `userKey` (filesystem-safe, from
`sessions/context.ts` `userKey()`), and `userName` (display), alongside the
existing `connector`/`channel`/`thread`. `sessions/manager.ts` fills these from
`msg.userId` / transport meta / `msg.user` at **both** `resolveMcpServers` call
sites (mcpConfigPath + guardrail toolbelt).

Injection is transport-aware:

- **stdio** (`command`/`args`/`env`) → merged into `env`:
  `JINN_USER_ID`, `JINN_USER_KEY`, `JINN_USER_NAME`, `JINN_CONNECTOR`,
  `JINN_CHANNEL` (only keys with a value). Existing `env` is preserved; these
  well-known keys are overwritten by the banto (authority).
- **url** (`type:"sse"` / `headers`) → merged into `headers`:
  `X-Banto-User-Id`, `X-Banto-User-Key`, `X-Banto-User-Name`,
  `X-Banto-Connector`, `X-Banto-Channel`. **Static auth headers
  (`Authorization`, …) are preserved** — only `X-Banto-*` are added.

When the session carries **no identity** (cron, internal calls, older callers)
nothing user-scoped is injected — fully backward compatible. Because MCP is
resolved **per turn**, the identity always reflects that turn's speaker. The
built-in **knowledge** 職人 is the reference consumer: given `JINN_USER_KEY` it
auto-scopes `read/write/list_knowledge` to `users/<key>/`. See
`docs/design/shokunin-contract.md` for the full env/header contract and the
per-user requirement all 職人 must honor.
