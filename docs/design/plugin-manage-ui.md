# Design: plugin management UI (Gated Install)

Status: **landed.** A WebUI + gateway API for viewing and installing the three
existing plugin kinds (engines / connectors / guardrails). Installing a plugin
runs `pnpm add <module>`, which pulls arbitrary code that then executes with the
daemon's own privileges — so this is a **strong, gated operation**, opt-in and
guarded server-side.

## Why gated

The install path is effectively "run arbitrary code as the daemon user": a
malicious npm package can execute during `pnpm add` (install scripts) and again
when the plugin's `create()` is dynamic-imported. There is no sandbox. The whole
feature is therefore:

1. **Opt-in** — `config.plugins.manageUi` must be exactly `true`. Absent/false →
   every `/api/plugins/*` route returns 403 and the UI hides the install form.
2. **Behind an edge auth proxy** — the intended deployment puts the gateway
   behind Keycloak via oauth2-proxy. The proxy authenticates the human and
   injects `X-Forwarded-Email` / `X-Forwarded-Groups`. oauth2-proxy strips any
   inbound `X-Forwarded-*` from untrusted clients and re-adds its own, so their
   presence is a reliable "came through the proxy" signal.
3. **Re-checked server-side** — the gateway never trusts the UI for
   authorization. `requirePluginAdmin()` runs on every route (see below). UI
   display control (hiding the form) is convenience only.

## Security model — `requirePluginAdmin(req, config)`

`packages/jimmy/src/gateway/plugins-api.ts`. Order of checks:

1. `config.plugins?.manageUi !== true` → **403** (feature off).
2. If `X-Forwarded-Groups` is present (proxy path): the comma-separated list must
   contain `config.plugins.adminGroup` (default `openbanto-admins`) →
   **allow**, `who = X-Forwarded-Email`. Missing group → **403**.
3. No `X-Forwarded-Groups` (no proxy): allow only when the socket is loopback
   (`127.0.0.1` / `::1` / `::ffff:127.0.0.1`) → `who = "localhost"`. This is the
   operator running `curl` on the box. Any other remote address → **403**.

The Host-header / CORS / loopback-bind guards in `gateway/server.ts` still apply
underneath (DNS-rebinding protection etc.).

### Module specifier validation — `validateModuleSpec()`

Before the specifier reaches `pnpm`, it must pass an **allow-list**:

- npm package name, optionally scoped, optionally `@version`
  (`@scope/pkg`, `pkg@1.2.3`, `pkg@latest`); OR
- a `git+https://…` URL.

Rejected: anything with a shell metacharacter or whitespace
(`; & | ` `` ` `` $ ( ) { } < > \ " ' \n`), local/absolute/relative paths
(`/…`, `./…`, `../…`, `~/…`, `C:\…`), `file:` / `link:` / `portal:` specifiers,
and every non-`git+https` protocol (`http:`, `https:`, `git:`, `git+ssh:`,
`ssh:`, bare `://`). Unit-tested in
`packages/jimmy/src/gateway/__tests__/plugins-api.test.ts`.

### execFile, not shell

`pnpm add` is invoked with `execFile("corepack", ["pnpm@10.6.4", "add", module], …)`
— an **argv array**, never a shell string. Combined with the validation above,
a crafted module string cannot inject a command. `cwd` is
`config.plugins.installRoot` or `process.cwd()` (the repo root the daemon was
started from). There is no `rm`/glob anywhere in the path.

### Audit

Every mutating operation (`install` / `toggle` / `config`) is audited via
`auditPluginAction()`: always `logger.info("[plugin-admin] {…}")` with
`{ who, action, pluginType, name, module, result }`, and — if a guardrail plugin
is configured — the same record is opportunistically flowed through the live
guardrail's `afterTurn` as a structured audit sink (best-effort; a no-op
guardrail's `afterTurn` is harmless, so this degrades to log-only).

## API

All routes require `requirePluginAdmin`.

| Route | Purpose |
|---|---|
| `GET /api/plugins` | Aggregate `engines` / `connectors` / `guardrails` from config. Each entry: `{ name, kind: "builtin"\|"module", module?, enabled, hasConfig }`. Builtins are recognized from each registry's `BUILTIN_*` names. |
| `POST /api/plugins/install` | `{ pluginType, name, module, config? }` → validate module, `pnpm add`, patch `config.yaml`, reload/needsRestart. Returns `stderr` on `pnpm` failure. |
| `POST /api/plugins/toggle` | `{ pluginType, name, enabled }` → engine: flip `engines.default`; connector: set `enabled`; guardrail: drop/keep `module`. |
| `PUT  /api/plugins/config` | `{ pluginType, name, config }` → replace that plugin's config block. |
| `POST /api/admin/restart` | Admin-only **self-restart** of the daemon. Replies `200 {restarting:true}`, flushes, then SIGTERMs its own pid; systemd restarts it. `409 {restarting:true, already:true}` when one is already in flight. |

Config is patched by the same merge-from-disk writer semantics as
`PUT /api/config` (read `config.yaml`, mutate, `yaml.dump`, write). `plugins` and
`guardrails` were added to `PUT /api/config`'s `KNOWN_KEYS`.

## Reload policy — connector hot, engine/guardrail restart

This mirrors the existing hot-reload seam in `gateway/server.ts`:

- **Connector** installs/toggles/config-updates call `reloadAllConnectors()`
  (the same path `POST /api/connectors/reload` and the chokidar watcher use), so
  they take effect **immediately** — the connector map is torn down and rebuilt
  from the new on-disk config.
- **Engine / guardrail** are constructed **once at boot** (the engines `Map` and
  the guardrail instance are injected into `SessionManager` at startup). Hot
  swapping them is out of scope, so the API returns `needsRestart: true` and the
  UI surfaces "反映にはデーモンの再起動が必要です" (restart required). This is an
  honest UX signal rather than a silent no-op.

`invalidateModelRegistry()` is always called after a patch so the model/engine
capability registry is rebuilt on next read.

## Self-restart — `POST /api/admin/restart` (`gateway/self-restart.ts`)

Engine / guardrail changes need a daemon restart (above). Rather than make the
operator shell into the box, the Plugins page offers an admin **"Banto を再起動"**
button. The mechanism relies on one load-bearing deployment fact:

> The banto daemon runs under a **systemd (user) unit `getworks-banto` with
> `Restart=always`** (実機 `gw-banto01`). If the process exits or is SIGTERM'd,
> systemd brings it straight back up.

So a "restart" is simply a **self-terminate** — we do **not** shell out to
`systemctl` (no `execFile`, no privileged call). The flow:

1. `requirePluginAdmin(req, config)` gate — the SAME gate as every
   `/api/plugins*` route (`manageUi:true` + `X-Forwarded-Groups` ∋ `adminGroup`,
   or a loopback socket). Non-admin / feature-off → `403`.
2. `auditPluginAction({ who, action:"daemon.restart", … })` — the same audit
   sink (logger + optional guardrail `afterTurn`) as the plugin routes.
3. **Single-flight**: a module-scoped `restarting` flag. A second call while one
   is armed returns `409 {restarting:true, already:true}` and arms nothing
   (guards double-click / concurrent admins).
4. Reply `200 {restarting:true}` and flush, **then** after a short delay (700ms)
   `process.kill(process.pid, "SIGTERM")`. The delay lets the HTTP response reach
   the client before the socket drops.
5. `SIGTERM` is caught by `lifecycle.ts`'s existing `shutdown` handler
   ("Shutting down gateway…"), which runs the **existing graceful shutdown**
   (mark running sessions `interrupted`, engines `killAll`, connectors `stop`,
   HTTP/WS servers close) with a 5s force-exit backstop, then `process.exit(0)`.
6. systemd (`Restart=always`) restarts the daemon with the new config in effect.

`gateway/self-restart.ts` isolates the mechanics (`armSelfRestart()` +
`isRestarting()`), with the `kill`/`pid` injectable so unit tests exercise the
single-flight + deferred-signal logic **without terminating the test runner**.
The route gate (non-admin→403, admin→`restarting`) and in-flight `409` are
covered in `admin-restart-endpoint.test.ts`.

## WebUI

`packages/web/src/app/plugins/page.tsx`, linked from the sidebar (`/plugins`,
Puzzle icon). Type tabs (engine / connector / guardrail), builtin/module badges,
an `enabled` checkbox per plugin, and an **Add plugin** form (pluginType, name,
module, config JSON). A persistent **trust warning banner** states that plugins
run with the daemon's privileges. When `config.plugins.manageUi` is false the
page shows an "この機能は無効です" card with the enablement snippet and hides the
install form. Data via `@/lib/api` (`getPlugins` / `installPlugin` /
`togglePlugin` / `updatePluginConfig`), matching the existing web data-fetch
conventions.

When `manageUi` is true a **"Banto を再起動"** button sits in the page header
(next to 再読込). Clicking it: `window.confirm` → `api.restartDaemon()` (POST
`/api/admin/restart`) → shows "再起動中…" → `pollDaemonHealthy()` polls
`GET /api/status` every ~1.5s (fetch failures during the down window are
swallowed and retried) until it responds `200` → "復帰しました", then refreshes
the page data. The button is disabled while a restart is in flight (連打防止);
failures / a poll timeout surface an inline message.
