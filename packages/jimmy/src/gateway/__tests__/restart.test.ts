import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process — restartGateway shells out to systemctl/sudo and forks.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(() => ""),
  fork: vi.fn(() => ({ pid: 4321, disconnect: vi.fn(), unref: vi.fn() })),
}));

// Mock fs so PID-file probing is fully controlled.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "1234"),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

// Avoid pulling the heavy gateway server graph in via lifecycle.ts.
vi.mock("../server.js", () => ({ startGateway: vi.fn() }));
vi.mock("../../shared/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: { port: 7777, host: "127.0.0.1" } })),
}));

import { execFileSync, fork } from "node:child_process";
import fs from "node:fs";

const mockExec = vi.mocked(execFileSync);
const mockFork = vi.mocked(fork);
const mockExistsSync = vi.mocked(fs.existsSync);

const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/** Build an execFileSync mock that drives systemctl is-active per scope. */
function systemctl(opts: {
  versionOk?: boolean;
  userActive?: boolean;
  systemActive?: boolean;
  systemRestartThrows?: boolean;
  sudoThrows?: boolean;
}) {
  mockExec.mockImplementation(((file: string, args?: readonly string[]) => {
    const a = args ?? [];
    if (file === "systemctl" && a[0] === "--version") {
      if (opts.versionOk === false) throw new Error("no systemctl");
      return "systemd 255";
    }
    if (file === "systemctl" && a.includes("is-active")) {
      const isUser = a[0] === "--user";
      const active = isUser ? opts.userActive : opts.systemActive;
      if (active) return "active\n";
      // is-active exits non-zero for inactive units.
      const err = new Error("inactive") as Error & { stdout: string };
      err.stdout = "inactive\n";
      throw err;
    }
    if (file === "systemctl" && a.includes("restart")) {
      if (a[0] !== "--user" && opts.systemRestartThrows) throw new Error("denied");
      return "";
    }
    if (file === "sudo") {
      if (opts.sudoThrows) throw new Error("sudo denied");
      return "";
    }
    return "";
  }) as unknown as typeof execFileSync);
}

describe("restartGateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("restarts a systemd --user unit when active (privilege-free)", async () => {
    setPlatform("linux");
    systemctl({ userActive: true });
    const { restartGateway } = await import("../lifecycle.js");

    const result = restartGateway();

    expect(result).toEqual({ method: "systemd-user", service: "openryoko" });
    expect(mockExec).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "restart", "openryoko"],
      expect.anything(),
    );
  });

  it("restarts the system unit when only the system scope is active", async () => {
    setPlatform("linux");
    systemctl({ userActive: false, systemActive: true });
    const { restartGateway } = await import("../lifecycle.js");

    const result = restartGateway();

    expect(result).toEqual({ method: "systemd-system", service: "openryoko" });
    expect(mockExec).toHaveBeenCalledWith(
      "systemctl",
      ["restart", "openryoko"],
      expect.anything(),
    );
  });

  it("falls back to sudo when a direct system restart is denied", async () => {
    setPlatform("linux");
    systemctl({ systemActive: true, systemRestartThrows: true });
    const { restartGateway } = await import("../lifecycle.js");

    const result = restartGateway();

    expect(result).toEqual({ method: "systemd-system", service: "openryoko", detail: "via sudo" });
    expect(mockExec).toHaveBeenCalledWith(
      "sudo",
      ["-n", "systemctl", "restart", "openryoko"],
      expect.anything(),
    );
  });

  it("reports permission denied when both direct and sudo restart fail", async () => {
    setPlatform("linux");
    systemctl({ systemActive: true, systemRestartThrows: true, sudoThrows: true });
    const { restartGateway } = await import("../lifecycle.js");

    const result = restartGateway();

    expect(result).toEqual({
      method: "systemd-system",
      service: "openryoko",
      detail: "permission denied",
    });
  });

  it("honors an explicit service name override", async () => {
    setPlatform("linux");
    systemctl({ userActive: true });
    const { restartGateway } = await import("../lifecycle.js");

    const result = restartGateway("openryoko@bot");

    expect(result.service).toBe("openryoko@bot");
    expect(mockExec).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "restart", "openryoko@bot"],
      expect.anything(),
    );
  });

  it("falls back to re-forking the daemon when no systemd unit is active", async () => {
    setPlatform("linux");
    systemctl({ userActive: false, systemActive: false });
    // PID file present + process.kill(pid, 0) succeeds → daemon is running.
    mockExistsSync.mockReturnValue(true);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as unknown as true);
    const { restartGateway } = await import("../lifecycle.js");

    const result = restartGateway();

    expect(result).toEqual({ method: "daemon" });
    expect(mockFork).toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("returns 'none' when nothing is running", async () => {
    setPlatform("linux");
    systemctl({ userActive: false, systemActive: false });
    mockExistsSync.mockReturnValue(false); // no PID file, no port listener
    const { restartGateway } = await import("../lifecycle.js");

    const result = restartGateway();

    expect(result).toEqual({ method: "none" });
    expect(mockFork).not.toHaveBeenCalled();
  });

  it("skips systemd entirely on non-linux platforms", async () => {
    setPlatform("darwin");
    mockExistsSync.mockReturnValue(false);
    const { restartGateway } = await import("../lifecycle.js");

    const result = restartGateway();

    expect(result).toEqual({ method: "none" });
    // systemctl --version must never be probed off-linux.
    expect(mockExec).not.toHaveBeenCalledWith("systemctl", ["--version"], expect.anything());
  });
});
