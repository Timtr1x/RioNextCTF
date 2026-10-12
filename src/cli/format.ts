export interface CampaignSummary {
  id: string;
  state: string;
  updated_at: string;
  pending_goal_claim: { id: string; proposition: string; fact_key: string } | null;
}

export function formatList(rows: CampaignSummary[]): string {
  if (!rows.length) return "no campaigns in this data dir. rionext run --url <target>";
  const width = Math.max(...rows.map((r) => r.id.length), 8);
  return rows
    .map((r) => {
      const flag = r.pending_goal_claim ? `  pending ${r.pending_goal_claim.proposition}` : "";
      return `${r.id.padEnd(width)}  ${r.state}${flag}`;
    })
    .join("\n");
}

export function formatStatus(s: Record<string, unknown>): string {
  const id = String(s.campaign_id ?? "");
  const state = String(s.state ?? "");
  const lines = [`${id}  ${state}`];
  const pending = s.pending_goal_claim as { proposition?: string; fact_key?: string; id?: string } | null;
  if (state === "awaiting_verify" || pending) {
    lines.push(`pending flag  ${pending?.proposition ?? "(none)"}`);
    lines.push(`verify        rionext accept ${id}`);
    lines.push(`              rionext reject ${id} --text "flag不正确" --continue`);
  }
  if (s.root_goal_satisfied) lines.push("goal          verified");
  const budget = s.budget as Record<string, unknown> | undefined;
  if (budget) {
    lines.push(`calls         ${budget.spent_calls}/${budget.total_calls}  free ${budget.free_calls}`);
    lines.push(`tokens        ${budget.spent_tokens}/${budget.total_tokens}`);
  }
  if (s.candidates_ready != null) lines.push(`ready steps   ${s.candidates_ready}`);
  const runs = (s.active_runs as { id?: string; mode?: string; state?: string }[] | undefined) ?? [];
  if (runs.length > 0) {
    for (const r of runs) lines.push(`active run    ${r.mode} ${r.state} ${r.id}`);
  } else {
    const run = s.active_run as { id?: string; mode?: string; state?: string } | null;
    if (run) lines.push(`active run    ${run.mode} ${run.state} ${run.id}`);
  }
  const fin = s.finalization as
    | {
        primary_finish_rate: number | null;
        finalizer_success_rate: number | null;
        protocol_complete_rate: number | null;
        execute_runs_total?: number;
        finish_primary_total?: number;
        finalizer_started_total?: number;
        finalizer_committed_total?: number;
      }
    | undefined;
  if (fin) {
    const pct = (n: number | null): string => (n == null ? "n/a" : `${(n * 100).toFixed(1)}%`);
    lines.push(`主动交卷率   ${pct(fin.primary_finish_rate)}  (${fin.finish_primary_total ?? 0}/${fin.execute_runs_total ?? 0})`);
    lines.push(`补交成功率   ${pct(fin.finalizer_success_rate)}  (${fin.finalizer_committed_total ?? 0}/${fin.finalizer_started_total ?? 0})`);
    lines.push(`最终协议完整率 ${pct(fin.protocol_complete_rate)}`);
  }
  return lines.join("\n");
}

export interface ProgressInvocation {
  created_at: string;
  kind: string;
  purpose: string | null;
  state: string;
  actual_tokens: number;
  status: string | null;
  error_json?: string | null;
}

function clock(iso: string): string {
  return iso.includes("T") ? iso.slice(11, 19) : iso;
}

export function formatProgress(
  at: string,
  status: Record<string, unknown>,
  inv: ProgressInvocation[],
): string {
  const id = String(status.campaign_id ?? "");
  const state = String(status.state ?? "");
  const budget = status.budget as Record<string, unknown> | undefined;
  const run = status.active_run as { id?: string; mode?: string; state?: string } | null;
  const calls = budget ? `${budget.spent_calls}/${budget.total_calls}` : "";
  const tokens = budget ? `${budget.spent_tokens}/${budget.total_tokens}` : "";
  const runBit = run ? `${run.mode} ${run.state}` : "idle";
  const lines = [`${clock(at)}  ${id}  ${state}  calls ${calls}  tokens ${tokens}  ${runBit}`];
  for (const row of inv.slice(0, 6)) {
    const tok = row.kind === "model" && row.actual_tokens ? ` ${row.actual_tokens} tok` : "";
    const err = row.state === "failed_known" || row.status === "aborted" || row.status === "timeout"
      ? ` ${row.status ?? row.state}`
      : "";
    lines.push(`         ${clock(row.created_at)}  ${row.kind} ${row.purpose ?? ""} ${row.state}${tok}${err}`.trimEnd());
  }
  if (!inv.length) lines.push("         (no invocations yet)");
  return lines.join("\n");
}

export function formatVerify(result: Record<string, unknown>, id: string, accept: boolean): string {
  const state = String(result.state ?? "");
  const prop = result.proposition ? String(result.proposition) : "";
  if (accept) {
    return [`accepted  ${id}  ${state}`, prop ? `flag      ${prop}` : ""].filter(Boolean).join("\n");
  }
  const next = state === "active" ? `next      rionext start ${id}` : "";
  return [`rejected  ${id}  ${state}`, prop ? `was       ${prop}` : "", "hint injected into campaign context", next]
    .filter(Boolean)
    .join("\n");
}
