# Handoff: 職人 (calendar / minutes / 📌ledger) as MCP tools — no core fork

Status: **handoff reference** for the AiDEA-side member. The "職人" tools —
calendar auto-register, meeting minutes (Whisper→summary→store), 📌pin-to-ledger —
attach to 番頭 as **MCP servers**. OpenBanto already wires MCP per turn, so you add
tools by **config + your own MCP server**, not by editing the core.

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
  **which** servers that employee (番頭 persona) may use — `true` = all, or an
  allow-list of server names.
- The engine (bob today, aidea next) receives `mcpConfigPath` and calls the tools.

So a 職人 = **one MCP server** registered in `config.mcp`, enabled on the 番頭
employee via `employee.mcp`.

## Add a 職人 (example: calendar)

1. Implement an MCP server (stdio or the shape `resolveMcpServers` expects) that
   exposes tools, e.g. `calendar.create_event({title, startsAt, attendees})`.
   The LLM's date/time extraction ("明日15時にA社と打ち合わせ" → ISO) happens in
   the model turn; the tool just performs the write.
2. Register it in the host config — **no core change**:

```yaml
mcp:
  servers:
    calendar:
      command: "node"
      args: ["/opt/banto-shokunin/calendar-mcp.js"]
      # env: { GOOGLE_...: ... }   # calendar creds live in the server, not the core
    minutes:
      command: "node"
      args: ["/opt/banto-shokunin/minutes-mcp.js"]   # Whisper→summary→store
    ledger:
      command: "node"
      args: ["/opt/banto-shokunin/ledger-mcp.js"]     # 📌 pin → append to ledger

employees:
  banto:
    persona: "越後湯沢の番頭。おもてなし、重い仕事はengineに委譲。"
    engine: aidea            # or bob
    mcp: ["calendar", "minutes", "ledger"]   # this 番頭's toolbelt
```

## Multi-番頭 (per-project assistants)

`Employee` carries `persona` + `engine` + `mcp`, so different 番頭 = different
personas with different toolbelts, all in one workspace. Route a channel/employee
to a project-specific 番頭 with a narrower `mcp` allow-list. This is the
"特定プロジェクト用に個別アシスタント複数" path — again config-only.

## 📌 pin → ledger specifics

The Slack connector already emits `reaction_added` (our manifest subscribes to it;
`connectors/slack/index.ts` derives `slack:reaction:<ch>:<ts>`). Two options:

- **Tool path (preferred):** a normal message turn invokes the `ledger` MCP tool
  to append the pinned message — keeps the write inside the guarded turn (audit,
  permissions apply).
- **Direct path:** handle the reaction event → call the ledger store directly.
  Faster but bypasses guardrails; only for low-risk appends.

## Boundary

- 職人 creds (Google, storage, Whisper endpoint) live **in the MCP server**, never
  in the core config beyond the `command/args/env` that launches it.
- The 番頭本体 (sakaigawa) owns `resolveMcpServers` / `mcpConfigPath` wiring; if a
  richer selection (per-channel, per-user toolbelts) is needed, that is a core
  change on the 番頭 side — request it rather than forking.
- "重要度の自動マーク" (triage延長) is a model+prompt concern, not a tool — coordinate
  the triage prompt with the 番頭 side.
