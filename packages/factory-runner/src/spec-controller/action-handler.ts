import type { FeatureSpec, SpecStatus } from "@darkfactory/contracts";
import type { DecisionLabel } from "./types.js";

const ACCEPT_STATUSES = new Set<SpecStatus>(["Critiqued", "Refined", "Approved"]);

export interface ActionResult {
  ok: boolean;
  message: string;
  updatedSpec: FeatureSpec;
  reason?: string;
}

export function applyDecisionAction(
  spec: FeatureSpec,
  label: DecisionLabel,
  now: string,
  reason?: string
): ActionResult {
  if (label === "factory/accept") {
    if (!ACCEPT_STATUSES.has(spec.status)) {
      return {
        ok: false,
        message: `accept requires status Critiqued/Refined/Approved. Current: ${spec.status}`,
        updatedSpec: { ...spec }
      };
    }
    return {
      ok: true,
      message: `Accepted ${spec.specId}`,
      updatedSpec: {
        ...spec,
        decision: "accept",
        status: "Approved",
        updatedAt: now
      }
    };
  }

  if (!reason?.trim()) {
    return {
      ok: false,
      message: `${label.replace("factory/", "")} requires rationale via /factory-reason ${spec.specId}: <reason>`,
      updatedSpec: { ...spec }
    };
  }

  if (label === "factory/veto") {
    return {
      ok: true,
      message: `Vetoed ${spec.specId}`,
      reason,
      updatedSpec: {
        ...spec,
        decision: "veto",
        updatedAt: now
      }
    };
  }

  return {
    ok: true,
    message: `Rolled back ${spec.specId}`,
    reason,
    updatedSpec: {
      ...spec,
      decision: "rollback",
      status: "Refined",
      updatedAt: now
    }
  };
}
