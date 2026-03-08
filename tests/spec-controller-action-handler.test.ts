import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDecisionAction } from "../packages/factory-runner/src/spec-controller/action-handler.js";
import type { FeatureSpec } from "@darkfactory/contracts";

const BASE_SPEC: FeatureSpec = {
  specId: "SPEC-TEST-1",
  title: "Spec test",
  source: "human",
  owner: "@maintainer",
  status: "Refined",
  decision: "pending",
  intent: "Intent that satisfies minimum critic checks and supports test coverage.",
  scenarios: [
    { id: "SCN-TEST-1", description: "scenario", required: true },
    { id: "SCN-TEST-2", description: "scenario", required: true }
  ],
  verification: [
    { scenarioId: "SCN-TEST-1", checks: ["unit"] },
    { scenarioId: "SCN-TEST-2", checks: ["e2e"] }
  ],
  riskNotes: "Risk: regression. Mitigation: tests and verification gates.",
  createdAt: "2026-03-08T00:00:00.000Z",
  updatedAt: "2026-03-08T00:00:00.000Z"
};

test("accept sets decision and Approved status", () => {
  const result = applyDecisionAction(BASE_SPEC, "factory/accept", "2026-03-08T03:00:00.000Z");
  assert.equal(result.ok, true);
  assert.equal(result.updatedSpec.status, "Approved");
  assert.equal(result.updatedSpec.decision, "accept");
});

test("veto requires reason", () => {
  const result = applyDecisionAction(BASE_SPEC, "factory/veto", "2026-03-08T03:00:00.000Z");
  assert.equal(result.ok, false);
});

test("rollback sets Refined and rollback decision", () => {
  const deployed: FeatureSpec = { ...BASE_SPEC, status: "Deployed", decision: "accept" };
  const result = applyDecisionAction(
    deployed,
    "factory/rollback",
    "2026-03-08T03:00:00.000Z",
    "Regression detected"
  );
  assert.equal(result.ok, true);
  assert.equal(result.updatedSpec.status, "Refined");
  assert.equal(result.updatedSpec.decision, "rollback");
});
