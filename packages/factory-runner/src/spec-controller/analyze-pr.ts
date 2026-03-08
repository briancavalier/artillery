import type { FeatureSpec, SpecStatus } from "@darkfactory/contracts";
import { criticChecks, validateSpec } from "@darkfactory/core";
import type { PullRequestFile, SpecAnalysis } from "./types.js";

const STATUS_ORDER: SpecStatus[] = [
  "Draft",
  "Critiqued",
  "Refined",
  "Approved",
  "Implemented",
  "Verified",
  "Deployed"
];

const AUTO_ANALYZE_STATUSES = new Set<SpecStatus>(["Draft", "Critiqued", "Refined"]);

export function findChangedSpecPaths(files: PullRequestFile[]): string[] {
  return files
    .map((file) => file.filename)
    .filter((path) => /^specs\/SPEC-[A-Za-z0-9-]+\.json$/.test(path) && path !== "specs/SPEC-TEMPLATE.json")
    .sort();
}

export function analyzeSpec(spec: FeatureSpec, path: string, now = new Date().toISOString()): SpecAnalysis {
  const validationIssues = validateSpec(spec);
  const criticIssues = criticChecks(spec);
  const issues = [...validationIssues, ...criticIssues];
  const blockers = issues.filter((issue) => /missing|must|required/i.test(issue));
  const score = Math.max(0, 100 - issues.length * 12 - blockers.length * 8);
  const hasValidationFailure = validationIssues.length > 0;

  let nextStatus = spec.status;
  if (AUTO_ANALYZE_STATUSES.has(spec.status) && !hasValidationFailure) {
    nextStatus = blockers.length === 0 ? "Refined" : "Critiqued";
  }

  if (STATUS_ORDER.indexOf(nextStatus) < STATUS_ORDER.indexOf(spec.status)) {
    nextStatus = spec.status;
  }

  const changed = nextStatus !== spec.status;
  const updatedSpec: FeatureSpec = changed
    ? {
      ...spec,
      status: nextStatus,
      updatedAt: now
    }
    : { ...spec };

  return {
    path,
    specId: spec.specId,
    scenarioId: spec.scenarios[0]?.id ?? "SCN-UNKNOWN",
    currentStatus: spec.status,
    nextStatus,
    changed,
    readiness: blockers.length === 0 && !hasValidationFailure ? "ready-for-decision" : "needs-refinement",
    score,
    issues,
    blockers,
    updatedSpec
  };
}
