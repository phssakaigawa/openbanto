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
- The engine (bob today, an HTTP engine next) receives `mcpConfigPath` and calls
  the tools.

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
