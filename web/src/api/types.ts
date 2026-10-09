/** API shapes mirroring src/web/routes-*.ts responses. */

export interface ApiErrorBody {
  error: { code: string; category: string; message: string; details?: Record<string, unknown> };
}

export interface Health {
  ok: boolean;
  at: string;
  docker: boolean;
  kali_master: boolean;
  keeper: string | null;
  data_dir: string;
  version: string;
  running: string[];
}

export interface BudgetSnapshot {
  currency?: string;
  price_version?: string;
  total_calls: number;
  free_calls: number;
  reserved_calls: number;
  liability_calls: number;
  spent_calls: number;
  overrun_calls: number;
  total_tokens: number;
  free_tokens: number;
  reserved_tokens: number;
  liability_tokens: number;
  spent_tokens: number;
  overrun_tokens: number;
  total_cost_micro: number;
  free_cost: number;
  reserved_cost: number;
  liability_cost: number;
  spent_cost: number;
  overrun_cost: number;
}

export interface PendingClaim {
  id: string;
  proposition: string;
  fact_key: string;
}

export interface SpecSummary {
  mode: string;
  statement: string;
  assets: string[];
  capabilities?: string[];
  capabilities_reason?: string[];
  challenge: { kind?: string; overlay?: string | null; confidence?: string; seed_method_family?: string } | null;
  budget: { max_calls?: number; max_tokens?: number; max_cost_micro?: number; deadline_ms?: number } | null;
  model: { provider: string; model: string } | null;
}

export interface CampaignRow {
  id: string;
  state: string;
  updated_at: string;
  pending_goal_claim: PendingClaim | null;
  running: boolean;
  budget: BudgetSnapshot;
  spec: SpecSummary;
}

export interface FinalizationStats {
  execute_runs_total: number;
  finish_primary_total: number;
  finalizer_started_total: number;
  finalizer_committed_total: number;
  finalizer_failed_total: number;
  incomplete_protocol_total: number;
  finish_conflict_total: number;
  finish_validation_error_total: number;
  primary_finish_rate: number | null;
  finalizer_success_rate: number | null;
  protocol_complete_rate: number | null;
}

export interface UncertainInvocation {
  id: string;
  purpose: string | null;
  effect_class: string | null;
  execution_id: string | null;
  state: string;
}

export interface CampaignView {
  campaign_id: string;
  state: string;
  active_run: { id: string; mode: string; state: string } | null;
  candidates_ready: number;
  blocked: number;
  budget: BudgetSnapshot;
  progress_epoch: number;
  stop_reason: string;
  schema_version: number;
  uncertain_invocations: UncertainInvocation[];
  operations_open: number;
  residual: { execution_id: string | null; invocation_id: string; killable: boolean; note: string }[];
  pending_goal_claim: PendingClaim | null;
  root_goal_satisfied: boolean;
  finalization: FinalizationStats;
  running: { instance_id: string; started_at: string } | null;
  spec: SpecSummary;
  created_at: string;
  updated_at: string;
}

export type Row = Record<string, unknown>;

export interface EventRow {
  event_id: string;
  campaign_id: string;
  seq: number;
  type: string;
  actor_json: string;
  entity_id: string | null;
  correlation_id: string;
  recorded_at: string;
  payload_json: string;
  consumed: number;
}

export interface ProviderRecord {
  id: string;
  display_name: string;
  protocol: string;
  base_url: string;
  created_at: string;
  api_key_set: boolean;
}

export interface ModelRecord {
  id: string;
  provider_id: string;
  name: string;
  available: boolean | null;
  vision: boolean | null;
  context_window: number | null;
  max_output_tokens: number | null;
}

export interface SlotAssignment {
  slot: string;
  provider_id: string | null;
  model_id: string | null;
}

export interface Catalog {
  providers: ProviderRecord[];
  models: ModelRecord[];
  slots: SlotAssignment[];
}

export interface ProbeCheck {
  ok: boolean;
  ms?: number;
  detail?: string;
  error?: string;
}

export interface ProbeReport {
  at: string;
  auth: ProbeCheck;
  text: ProbeCheck;
  tools: ProbeCheck;
  vision: ProbeCheck;
  reasoning: ProbeCheck;
  variants?: { name: string; ok: boolean; detail?: string }[];
}

export interface TriageEvidence {
  source: string;
  value: string;
  weight: number;
}

export interface TriageResult {
  kind: string;
  overlay?: string | null;
  confidence: string;
  evidence: TriageEvidence[];
  seed_method_family: string;
  skill_pack?: string;
}

export interface TriagePreview {
  campaign_id: string;
  source_name: string;
  files: number;
  total_bytes: number;
  sha256: string;
  detected: string;
  triage: TriageResult;
  capabilities?: string[];
}

export interface KaliStatus {
  docker: boolean;
  image?: string;
  master_tag?: string;
  base?: string;
  context?: string;
  master_present?: boolean;
  master_id?: string | null;
  master_tag_id?: string | null;
  keeper?: string;
  keeper_present?: boolean;
  keeper_status?: string | null;
  note?: string;
  error?: string;
}

export interface UiTask {
  id: string;
  kind: string;
  label: string;
  status: "running" | "done" | "error";
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  log: string;
  result: unknown;
}

export interface UiConfig {
  data_dir: string;
  db_path: string;
  artifact_root: string;
  instance_id: string;
  version: string;
  limits: {
    max_decide_turns: number;
    max_execute_turns_per_run: number;
    max_tool_calls_per_run: number;
    max_transient_retries_per_invocation: number;
    lease_ttl_ms: number;
    heartbeat_ms: number;
    tool_preview_limit: number;
    finalization: { enabled: boolean; max_output_tokens?: number };
  };
  controller_locks: { campaign_id: string; owner: string; acquired_at: string; heartbeat_at: string; lease_until: number; generation: number }[];
}
