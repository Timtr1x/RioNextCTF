export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  spec_json TEXT NOT NULL,
  state TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  cancel_epoch INTEGER NOT NULL DEFAULT 0,
  event_head INTEGER NOT NULL DEFAULT 0,
  progress_epoch INTEGER NOT NULL DEFAULT 0,
  reviewed_seq INTEGER NOT NULL DEFAULT 0,
  requested_seq INTEGER NOT NULL DEFAULT 0,
  empty_reviews INTEGER NOT NULL DEFAULT 0,
  admission_open INTEGER NOT NULL DEFAULT 1,
  decide_lock_owner TEXT,
  decide_lock_until INTEGER,
  execute_lock_owner TEXT,
  execute_lock_until INTEGER,
  execute_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS controller_locks (
  campaign_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT,
  lease_until INTEGER,
  generation INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  source_run_id TEXT,
  source_submission_id TEXT,
  statement TEXT NOT NULL,
  parent_id TEXT,
  is_root INTEGER NOT NULL,
  success_predicate_ref TEXT NOT NULL,
  mandatory INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  retired_reason TEXT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  source_run_id TEXT,
  source_submission_id TEXT,
  attempt_id TEXT,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT NOT NULL,
  subject TEXT NOT NULL,
  identity_ref TEXT,
  conditions_json TEXT NOT NULL DEFAULT '{}',
  env_rev TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  body_json TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  source_run_id TEXT,
  source_submission_id TEXT,
  proposition TEXT NOT NULL,
  fact_key TEXT,
  epistemic_status TEXT NOT NULL,
  source_grade TEXT NOT NULL,
  validity TEXT NOT NULL,
  support_refs_json TEXT NOT NULL DEFAULT '[]',
  counter_refs_json TEXT NOT NULL DEFAULT '[]',
  conditions_json TEXT NOT NULL DEFAULT '{}',
  supersedes TEXT,
  env_rev TEXT,
  observed_at TEXT,
  identity_ref TEXT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  source_run_id TEXT,
  source_submission_id TEXT,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  goal_refs_json TEXT NOT NULL DEFAULT '[]',
  input_refs_json TEXT NOT NULL DEFAULT '[]',
  preconditions_json TEXT NOT NULL,
  method_family TEXT NOT NULL,
  expected_observations_json TEXT NOT NULL DEFAULT '[]',
  completion_criteria TEXT NOT NULL,
  resource_claims_json TEXT NOT NULL DEFAULT '[]',
  budget_hint_json TEXT NOT NULL DEFAULT '{}',
  fingerprint TEXT NOT NULL,
  reopen_rule_json TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  ready_since TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retry_reason TEXT,
  blocked_reason TEXT,
  last_failure TEXT,
  merged_into TEXT,
  last_served_at TEXT,
  active_run_id TEXT,
  next_action TEXT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  step_id TEXT,
  mode TEXT NOT NULL,
  kind TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  context_manifest_json TEXT,
  lease_owner TEXT NOT NULL,
  fence INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  state TEXT NOT NULL,
  end_reason TEXT,
  outcome_json TEXT,
  continuation_of TEXT,
  finish_requested INTEGER NOT NULL DEFAULT 0,
  env_admission INTEGER NOT NULL DEFAULT 1,
  finish_submission_id TEXT,
  finish_payload_json TEXT,
  finish_submitted_at TEXT,
  primary_stop_trigger TEXT,
  last_error TEXT,
  finalize_attempted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS invocations (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  call_id TEXT,
  purpose TEXT,
  idempotency_key TEXT,
  request_ref TEXT,
  state TEXT NOT NULL,
  dispatch_epoch INTEGER NOT NULL DEFAULT 0,
  fence INTEGER NOT NULL,
  cancel_epoch INTEGER NOT NULL,
  external_id TEXT,
  usage_json TEXT,
  effect_class TEXT,
  reserved_cost INTEGER NOT NULL DEFAULT 0,
  actual_cost INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  actual_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_calls INTEGER NOT NULL DEFAULT 0,
  prompt_hash TEXT,
  requested_model TEXT,
  actual_model TEXT,
  provider TEXT,
  status TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  source_run_id TEXT,
  source_submission_id TEXT,
  claim TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  conditions_json TEXT NOT NULL DEFAULT '{}',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  verification_refs_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  impact TEXT,
  confidence_model TEXT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  finding_or_fact_ref TEXT NOT NULL,
  method TEXT NOT NULL,
  independence_json TEXT NOT NULL DEFAULT '{}',
  observations_json TEXT NOT NULL DEFAULT '[]',
  verdict TEXT NOT NULL,
  limits_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS coverage_items (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  source_run_id TEXT,
  source_submission_id TEXT,
  obligation TEXT NOT NULL,
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  applicability TEXT NOT NULL,
  execution_state TEXT NOT NULL,
  outcome TEXT NOT NULL,
  evidence_state TEXT NOT NULL,
  mandatory INTEGER NOT NULL,
  waiver_reason TEXT,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  path TEXT NOT NULL,
  producer_attempt TEXT,
  integrity_state TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  entity_id TEXT,
  entity_revision INTEGER,
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  submission_id TEXT,
  recorded_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (campaign_id, seq),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS submissions (
  campaign_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, producer_id, submission_id)
);

CREATE TABLE IF NOT EXISTS decision_runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  read_set_json TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  committed INTEGER NOT NULL,
  reviewed_seq INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  run_id TEXT,
  note TEXT NOT NULL,
  next TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS budget_accounts (
  campaign_id TEXT PRIMARY KEY,
  currency TEXT NOT NULL,
  price_version TEXT NOT NULL,
  total_cost_micro INTEGER NOT NULL,
  free_cost INTEGER NOT NULL,
  reserved_cost INTEGER NOT NULL,
  liability_cost INTEGER NOT NULL,
  spent_cost INTEGER NOT NULL,
  overrun_cost INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  free_tokens INTEGER NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  liability_tokens INTEGER NOT NULL,
  spent_tokens INTEGER NOT NULL,
  overrun_tokens INTEGER NOT NULL,
  total_calls INTEGER NOT NULL,
  free_calls INTEGER NOT NULL,
  reserved_calls INTEGER NOT NULL,
  liability_calls INTEGER NOT NULL,
  spent_calls INTEGER NOT NULL,
  overrun_calls INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS budget_entries (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  resource TEXT NOT NULL,
  invocation_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, idempotency_key),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS world_state (
  campaign_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS report_snapshots (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE INDEX IF NOT EXISTS idx_steps_campaign_status ON steps(campaign_id, status, kind, priority, ready_since);
CREATE INDEX IF NOT EXISTS idx_steps_fingerprint ON steps(campaign_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_events_campaign_seq ON events(campaign_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_unconsumed ON events(campaign_id, consumed, seq);
CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(campaign_id, fact_key);
CREATE INDEX IF NOT EXISTS idx_runs_campaign ON task_runs(campaign_id, state);
CREATE INDEX IF NOT EXISTS idx_inv_campaign ON invocations(campaign_id, state);
CREATE INDEX IF NOT EXISTS idx_findings_dedup ON findings(campaign_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_obs_subject ON observations(campaign_id, subject);

CREATE TABLE IF NOT EXISTS operations (
  execution_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  invocation_id TEXT,
  state TEXT NOT NULL,
  next_poll_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS resource_locks (
  lock_key TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  invocation_id TEXT,
  effect_known INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, lock_key),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_locks_key ON resource_locks(lock_key);
`;
