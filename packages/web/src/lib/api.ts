export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  name?: string
  input?: Record<string, unknown>
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system'
  content: TranscriptContentBlock[]
}

export interface QueueItem {
  id: string;
  sessionId: string;
  prompt: string;
  status: 'pending' | 'running' | 'cancelled' | 'completed';
  position: number;
  createdAt: string;
}

export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  emoji?: string;
  alwaysNotify?: boolean;
  reportsTo?: string | string[];
  parentName?: string | null;
  directReports?: string[];
  depth?: number;
  chain?: string[];
}

export interface OrgWarning {
  employee: string;
  type: string;
  message: string;
  ref?: string;
}

export interface OrgHierarchy {
  root: string | null;
  sorted: string[];
  warnings: OrgWarning[];
}

export interface OrgData {
  departments: string[];
  employees: Employee[];
  hierarchy: OrgHierarchy;
}

export interface PluginEntry {
  name: string;
  kind: "builtin" | "module";
  module?: string;
  enabled: boolean;
  hasConfig: boolean;
  impl?: string;
  /** Non-secret openai engine fields (apiKey never included — only hasApiKey). */
  openai?: { baseUrl?: string; model?: string; temperature?: number; hasApiKey: boolean };
  /** Non-secret view of the built-in "sample" guardrail policy (audit endpoint
   *  masked to hasAuditEndpoint — never included). */
  sample?: {
    allowUsers: string[];
    denyKeywords: string[];
    approvalTools: string[];
    approvers: string[];
    auditSink: "log" | "http";
    hasAuditEndpoint: boolean;
  };
}

export interface PluginsSummary {
  manageUi: boolean;
  adminGroup: string;
  engines: PluginEntry[];
  connectors: PluginEntry[];
  guardrails: PluginEntry[];
}

const BASE =
  typeof window !== "undefined"
    ? window.location.origin
    : "http://127.0.0.1:7777";

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body.error) return String(body.error);
    if (body.message) return String(body.message);
  } catch {
    // Response wasn't JSON — fall through
  }
  return `API error: ${res.status}`;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.json();
}

interface UploadedFile {
  id: string
  filename: string
  size: number
  mimetype: string | null
}

export const api = {
  getStatus: () => get<Record<string, unknown>>("/api/status"),
  getSessions: () => get<Record<string, unknown>[]>("/api/sessions"),
  getSession: (id: string) => get<Record<string, unknown>>(`/api/sessions/${id}`),
  getSessionChildren: (id: string) => get<Record<string, unknown>[]>(`/api/sessions/${id}/children`),
  updateSession: (id: string, data: { title?: string }) =>
    put<Record<string, unknown>>(`/api/sessions/${id}`, data),
  deleteSession: (id: string) => del<Record<string, unknown>>(`/api/sessions/${id}`),
  duplicateSession: (id: string) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/duplicate`, {}),
  bulkDeleteSessions: (ids: string[]) =>
    post<{ status: string; count: number }>("/api/sessions/bulk-delete", { ids }),
  createSession: (data: Record<string, unknown>) =>
    post<Record<string, unknown>>("/api/sessions", data),
  createStubSession: (data: Record<string, unknown>) =>
    post<Record<string, unknown>>("/api/sessions/stub", data),
  sendMessage: (id: string, data: Record<string, unknown>) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/message`, data),
  stopSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/stop`, {}),
  resetSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/reset`, {}),
  getCronJobs: () => get<Record<string, unknown>[]>("/api/cron"),
  getCronRuns: (id: string) => get<Record<string, unknown>[]>(`/api/cron/${id}/runs`),
  updateCronJob: (id: string, data: Record<string, unknown>) =>
    put<Record<string, unknown>>(`/api/cron/${id}`, data),
  triggerCronJob: (id: string) =>
    post<Record<string, unknown>>(`/api/cron/${id}/trigger`, {}),
  getOrg: () => get<OrgData>("/api/org"),
  getEmployee: (name: string) => get<Employee>(`/api/org/employees/${name}`),
  updateEmployee: (name: string, data: { alwaysNotify?: boolean }) =>
    patch<{ status: string }>(`/api/org/employees/${name}`, data),
  getDepartmentBoard: (name: string) =>
    get<Record<string, unknown>>(`/api/org/departments/${name}/board`),
  getPlugins: () => get<PluginsSummary>("/api/plugins"),
  installPlugin: (data: {
    pluginType: "engine" | "connector" | "guardrail";
    name: string;
    module: string;
    config?: Record<string, unknown>;
  }) =>
    post<{ status: string; needsRestart?: boolean; stderr?: string; message?: string; reloaded?: unknown }>(
      "/api/plugins/install",
      data,
    ),
  togglePlugin: (data: {
    pluginType: "engine" | "connector" | "guardrail";
    name: string;
    enabled: boolean;
  }) =>
    post<{ status: string; needsRestart?: boolean; message?: string }>("/api/plugins/toggle", data),
  updatePluginConfig: (data: {
    pluginType: "engine" | "connector" | "guardrail";
    name: string;
    config: Record<string, unknown>;
  }) => put<{ status: string; needsRestart?: boolean; message?: string }>("/api/plugins/config", data),
  /** Create/update a built-in OpenAI-compatible engine (impl:"openai"). Omit
   *  apiKey on an edit to keep the stored key. No pnpm add; needs a restart. */
  upsertOpenAiEngine: (data: {
    name: string;
    baseUrl: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
  }) =>
    post<{ status: string; needsRestart?: boolean; message?: string; created?: boolean }>(
      "/api/plugins/engine-openai",
      data,
    ),
  /** Set the single guardrail policy. policy=none clears it (→ allow-all);
   *  policy=sample writes the in-tree impl:"sample" from flat fields (no pnpm
   *  add); policy=module writes an external spec + JSON config. Needs a restart.
   *  auditEndpoint is stored server-side and never echoed back. */
  setGuardrail: (data: {
    policy: "none" | "sample" | "module";
    allowUsers?: string[];
    denyKeywords?: string[];
    denyReason?: string;
    approvalTools?: string[];
    approvers?: string[];
    approvalReason?: string;
    auditSink?: "log" | "http";
    auditEndpoint?: string;
    module?: string;
    config?: Record<string, unknown>;
  }) =>
    post<{ status: string; needsRestart?: boolean; message?: string; policy?: string }>(
      "/api/plugins/guardrail",
      data,
    ),
  /** Admin-only: ask the daemon to self-restart. It replies 200
   *  {restarting:true} and then (after a short delay) SIGTERMs itself; systemd
   *  (Restart=always) brings it back. 409 {already:true} if one is in flight. */
  restartDaemon: () =>
    post<{ restarting: boolean; already?: boolean }>("/api/admin/restart", {}),
  getSkills: () => get<Record<string, unknown>[]>("/api/skills"),
  getSkill: (name: string) => get<Record<string, unknown>>(`/api/skills/${name}`),
  getConfig: () => get<Record<string, unknown>>("/api/config"),
  reloadConnectors: () =>
    post<{ started: string[]; stopped: string[]; errors: string[] }>("/api/connectors/reload", {}),
  updateConfig: (data: Record<string, unknown>) =>
    put<Record<string, unknown>>("/api/config", data),
  getLogs: (n?: number) =>
    get<{ lines: string[] }>(`/api/logs${n ? `?n=${n}` : ""}`),
  getOnboarding: () =>
    get<{ needed: boolean; onboarded: boolean; sessionsCount: number; hasEmployees: boolean; portalName: string | null; operatorName: string | null }>("/api/onboarding"),
  completeOnboarding: (data: { portalName?: string; operatorName?: string; language?: string }) =>
    post<{ status: string; portal: { portalName?: string; operatorName?: string; language?: string } }>("/api/onboarding", data),
  getActivity: () =>
    get<Array<{ event: string; payload: unknown; ts: number }>>("/api/activity"),
  updateDepartmentBoard: (name: string, data: unknown) =>
    put<Record<string, unknown>>(`/api/org/departments/${name}/board`, data),
  sttStatus: () =>
    get<{ available: boolean; model: string | null; downloading: boolean; progress: number; languages: string[] }>("/api/stt/status"),
  sttDownload: () =>
    post<{ status: string; model: string }>("/api/stt/download", {}),
  sttTranscribe: async (audioBlob: Blob, language?: string): Promise<{ text: string }> => {
    const params = language ? `?language=${encodeURIComponent(language)}` : "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000); // 5 min timeout
    try {
      const res = await fetch(`${BASE}/api/stt/transcribe${params}`, {
        method: "POST",
        headers: { "Content-Type": audioBlob.type || "audio/webm" },
        body: audioBlob,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("Transcription timed out (5 min)");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  },
  sttUpdateConfig: (languages: string[]) =>
    put<{ status: string; languages: string[] }>("/api/stt/config", { languages }),
  getSessionQueue: (id: string) =>
    get<QueueItem[]>(`/api/sessions/${id}/queue`),
  cancelQueueItem: (sessionId: string, itemId: string) =>
    del<{ status: string }>(`/api/sessions/${sessionId}/queue/${itemId}`),
  clearSessionQueue: (sessionId: string) =>
    del<{ status: string; cancelled: number }>(`/api/sessions/${sessionId}/queue`),
  pauseSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/pause`, {}),
  resumeSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/resume`, {}),
  getSessionTranscript: (id: string) =>
    get<TranscriptEntry[]>(`/api/sessions/${id}/transcript`),
  uploadFile: async (file: File): Promise<UploadedFile> => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`${BASE}/api/files`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(await extractErrorMessage(res))
    return res.json()
  },
};

/**
 * Poll the daemon health endpoint until it responds 200 (i.e. the gateway has
 * come back after a restart), or `timeoutMs` elapses. While the daemon is down
 * fetch rejects (connection refused) — those errors are swallowed and retried.
 * Returns true if the daemon came back healthy, false on timeout.
 */
export async function pollDaemonHealthy(
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const deadline = Date.now() + timeoutMs;
  // Small initial delay: the daemon has only just been asked to go down, so an
  // immediate probe would hit the still-alive old process and report healthy.
  await new Promise((r) => setTimeout(r, intervalMs));
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2_000);
      const res = await fetch(`${BASE}/api/status`, {
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(t);
      if (res.ok) return true;
    } catch {
      // Down / connection refused — expected during the restart window. Retry.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
