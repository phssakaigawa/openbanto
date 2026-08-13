import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { JinnConfig } from "../../shared/types.js";

// RYOKO_HOME must be set before any import pulls in shared/paths.js.
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "admin-restart-home-"));

// Mock the self-restart mechanics so the test runner is NEVER actually SIGTERM'd.
// We control armed/already and observe that the route arms exactly once.
const armSelfRestart = vi.fn();
let restartingState = false;
vi.mock("../self-restart.js", () => ({
  armSelfRestart: (...args: unknown[]) => armSelfRestart(...args),
  isRestarting: () => restartingState,
}));

const STUB_CONFIG = {
  jinn: { version: "0.0.0" },
  gateway: { port: 0, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "" },
    codex: { bin: "codex", model: "" },
  },
  connectors: {},
  sessions: {},
  plugins: { manageUi: true, adminGroup: "openbanto-admins" },
  logging: { level: "error", stdout: false, file: "" },
} as unknown as JinnConfig;

describe("POST /api/admin/restart", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { handleApiRequest } = await import("../api.js");
    const { SessionManager } = await import("../../sessions/manager.js");
    const sessionManager = new SessionManager(STUB_CONFIG, new Map(), []);
    const context = {
      config: STUB_CONFIG,
      getConfig: () => STUB_CONFIG,
      sessionManager,
      startTime: 0,
      emit: () => {},
      connectors: new Map(),
    };
    server = http.createServer((req, res) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleApiRequest(req, res, context as any);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  beforeEach(() => {
    armSelfRestart.mockReset();
    restartingState = false;
  });

  // The remote socket in these fetches is loopback (127.0.0.1), which
  // requirePluginAdmin treats as authorized ONLY when no X-Forwarded-Groups is
  // present. To exercise the *non-admin* path we send an explicit
  // X-Forwarded-Groups WITHOUT the admin group — that takes the proxy branch and
  // is denied regardless of the loopback socket.
  it("403s a non-admin caller (proxy headers, wrong group)", async () => {
    armSelfRestart.mockReturnValue({ armed: true, already: false });
    const res = await fetch(`${baseUrl}/api/admin/restart`, {
      method: "POST",
      headers: { "X-Forwarded-Groups": "some-other-group", "X-Forwarded-Email": "eve@example.com" },
    });
    expect(res.status).toBe(403);
    expect(armSelfRestart).not.toHaveBeenCalled();
  });

  it("403s when manageUi is disabled", async () => {
    // Rebuild a server whose config has manageUi:false.
    const { handleApiRequest } = await import("../api.js");
    const { SessionManager } = await import("../../sessions/manager.js");
    const cfg = { ...STUB_CONFIG, plugins: { manageUi: false } } as unknown as JinnConfig;
    const ctx = {
      config: cfg,
      getConfig: () => cfg,
      sessionManager: new SessionManager(cfg, new Map(), []),
      startTime: 0,
      emit: () => {},
      connectors: new Map(),
    };
    const srv = http.createServer((req, res) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleApiRequest(req, res, ctx as any),
    );
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/restart`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(armSelfRestart).not.toHaveBeenCalled();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it("arms a restart for an admin caller and returns 200 {restarting:true}", async () => {
    armSelfRestart.mockReturnValue({ armed: true, already: false });
    const res = await fetch(`${baseUrl}/api/admin/restart`, {
      method: "POST",
      headers: { "X-Forwarded-Groups": "openbanto-admins", "X-Forwarded-Email": "admin@example.com" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ restarting: true });
    expect(armSelfRestart).toHaveBeenCalledTimes(1);
  });

  it("returns 409 {already:true} when a restart is already in flight (no second arm)", async () => {
    restartingState = true; // isRestarting() → true
    const res = await fetch(`${baseUrl}/api/admin/restart`, {
      method: "POST",
      headers: { "X-Forwarded-Groups": "openbanto-admins", "X-Forwarded-Email": "admin@example.com" },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ restarting: true, already: true });
    expect(armSelfRestart).not.toHaveBeenCalled();
  });
});
