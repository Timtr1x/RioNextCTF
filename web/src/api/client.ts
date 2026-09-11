import type {
  ApiErrorBody,
  BudgetSnapshot,
  CampaignRow,
  CampaignView,
  Catalog,
  EventRow,
  Health,
  KaliStatus,
  ModelRecord,
  ProbeReport,
  ProviderRecord,
  Row,
  SlotAssignment,
  TriagePreview,
  UiConfig,
  UiTask,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly category: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(method: string, path: string, body?: unknown, raw?: BodyInit, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const err = (parsed as ApiErrorBody)?.error;
    if (err) throw new ApiError(err.code, err.category, err.message, err.details);
    throw new ApiError("http_" + res.status, "invalid_input", `${method} ${path} -> ${res.status}`);
  }
  return parsed as T;
}

const get = <T>(path: string) => req<T>("GET", path);
const post = <T>(path: string, body?: unknown) => req<T>("POST", path, body ?? {});
const patch = <T>(path: string, body: unknown) => req<T>("PATCH", path, body);
const del = <T>(path: string) => req<T>("DELETE", path);

export const api = {
  health: () => get<Health>("/api/health"),
  config: () => get<UiConfig>("/api/config"),

  campaigns: () => get<{ campaigns: CampaignRow[] }>("/api/campaigns"),
  campaign: (id: string) => get<CampaignView>(`/api/campaigns/${encodeURIComponent(id)}`),
  createCampaign: (body: {
    url?: string;
    spec?: unknown;
    spec_path?: string;
    input_path?: string;
    upload_id?: string;
    label?: string;
    kind?: string;
    endpoint?: string;
    web_url?: string;
    hint?: string;
    id?: string;
    start?: boolean;
  }) => post<{ id: string; created: boolean; state: string; started: boolean }>("/api/campaigns", body),
  start: (id: string) => post(`/api/campaigns/${enc(id)}/start`),
  pause: (id: string) => post(`/api/campaigns/${enc(id)}/pause`),
  resume: (id: string) => post<{ id: string; state: string; started: boolean }>(`/api/campaigns/${enc(id)}/resume`),
  cancel: (id: string) => post(`/api/campaigns/${enc(id)}/cancel`),
  hint: (id: string, text: string) => post(`/api/campaigns/${enc(id)}/hint`, { text }),
  verify: (id: string, body: { accept: boolean; text?: string; fact_id?: string; continue?: boolean }) =>
    post<{ state: string; fact_id?: string; proposition?: string; epoch: number; continued: boolean }>(`/api/campaigns/${enc(id)}/verify`, body),
  reviseBudget: (id: string, patch: { max_calls?: number; max_tokens?: number; max_cost_micro?: number }) =>
    post(`/api/campaigns/${enc(id)}/budget`, patch),
  reconcile: (id: string, invocation_id?: string) =>
    post<{ prepared_released: number; marked_uncertain: number; reconciled: number; still_running: number }>(
      `/api/campaigns/${enc(id)}/reconcile`,
      invocation_id ? { invocation_id } : {},
    ),
  explainStep: (id: string, step: string) => get<Row>(`/api/campaigns/${enc(id)}/explain-step?step=${enc(step)}`),
  list: (id: string, table: string) => get<{ table: string; rows: Row[] }>(`/api/campaigns/${enc(id)}/list/${table}`),
  events: (id: string, after = 0, limit = 200) =>
    get<{ events: EventRow[]; after: number; head: number }>(`/api/campaigns/${enc(id)}/events?after=${after}&limit=${limit}`),
  report: (id: string) => get<{ id: string; report: unknown; generated: boolean }>(`/api/campaigns/${enc(id)}/report`),
  regenerateReport: (id: string) => post<{ id: string; report: unknown; generated: boolean }>(`/api/campaigns/${enc(id)}/report`),
  operations: (id: string) => get<{ operations: Row[] }>(`/api/campaigns/${enc(id)}/operations`),
  artifactContent: (id: string, aid: string, offset = 0, length = 262144) =>
    get<{ id: string; mime: string; size: number; offset: number; length: number; has_more: boolean; text: string }>(
      `/api/campaigns/${enc(id)}/artifacts/${enc(aid)}/content?offset=${offset}&length=${length}`,
    ),

  upload: (file: { name: string; path?: string; data: Blob | ArrayBuffer }, opts: { uploadId?: string; label?: string } = {}) =>
    req<{ upload_id: string; stored: string; files: number; total_bytes: number }>("POST", "/api/uploads", undefined, file.data, {
      "x-file-name": file.name,
      ...(file.path ? { "x-file-path": file.path } : {}),
      ...(opts.uploadId ? { "x-upload-id": opts.uploadId } : {}),
      ...(opts.label ? { "x-upload-label": opts.label } : {}),
    }),
  fetchUpload: (body: { url: string; upload_id?: string; label?: string }) =>
    post<{ upload_id: string; stored: string; files: number; total_bytes: number; bytes: number; sha256: string }>(
      "/api/uploads/fetch",
      body,
    ),
  triage: (body: { upload_id?: string; input_path?: string; label?: string; kind?: string; endpoint?: string; web_url?: string; hint?: string }) =>
    post<TriagePreview>("/api/triage", body),

  catalog: () => get<Catalog>("/api/catalog"),
  addProvider: (body: { display_name: string; protocol: string; base_url: string; api_key: string }) =>
    post<ProviderRecord>("/api/providers", body),
  updateProvider: (id: string, body: { display_name?: string; protocol?: string; base_url?: string; api_key?: string }) =>
    patch<ProviderRecord>(`/api/providers/${enc(id)}`, body),
  setProviderKey: (id: string, api_key: string) => post(`/api/providers/${enc(id)}/key`, { api_key }),
  clearProviderKey: (id: string) => post(`/api/providers/${enc(id)}/key`, { clear: true }),
  removeProvider: (id: string) => del(`/api/providers/${enc(id)}`),
  addModel: (body: { provider_id: string; name: string; context_window?: number; max_output_tokens?: number; vision?: boolean }) =>
    post<ModelRecord>("/api/models", body),
  removeModel: (id: string) => del(`/api/models/${enc(id)}`),
  testModel: (provider_id: string, model_id: string) => post<{ model: string; available: boolean; report: ProbeReport }>("/api/test", { provider_id, model_id }),
  assignSlot: (slot: string, ref: string) => post<SlotAssignment>("/api/slots", { slot, ref }),

  kaliStatus: () => get<KaliStatus>("/api/kali/status"),
  kaliOp: (op: "pull" | "build" | "protect" | "smoke") => post<{ task: UiTask; already_running: boolean }>(`/api/kali/${op}`),
  tasks: () => get<{ tasks: UiTask[] }>("/api/tasks"),
  task: (id: string) => get<UiTask>(`/api/tasks/${enc(id)}`),
  backup: (dest_dir?: string) => post<{ dest_dir: string; report: unknown }>("/api/backup", dest_dir ? { dest_dir } : {}),
  restore: (from: string) => post("/api/restore", { from }),
};

function enc(s: string): string {
  return encodeURIComponent(s);
}

export type { BudgetSnapshot };
