import { DomainError } from "./errors.ts";
import {
  CAMPAIGN_TRANSITIONS,
  FINDING_TRANSITIONS,
  STEP_TRANSITIONS,
  type CampaignState,
  type FindingStatus,
  type StepStatus,
} from "./types.ts";

export function assertTransition<S extends string>(
  table: Record<S, S[]>,
  from: S,
  to: S,
  kind: string,
): void {
  const allowed = table[from];
  if (!allowed?.includes(to)) {
    throw new DomainError(
      "illegal_transition",
      `${kind} cannot move from ${from} to ${to}`,
      "invalid_input",
      { kind, from, to },
    );
  }
}

export function transitionCampaign(from: CampaignState, to: CampaignState): CampaignState {
  assertTransition(CAMPAIGN_TRANSITIONS, from, to, "campaign");
  return to;
}

export function transitionStep(from: StepStatus, to: StepStatus): StepStatus {
  assertTransition(STEP_TRANSITIONS, from, to, "step");
  return to;
}

export function transitionFinding(from: FindingStatus, to: FindingStatus): FindingStatus {
  assertTransition(FINDING_TRANSITIONS, from, to, "finding");
  return to;
}
