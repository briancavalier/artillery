import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSpec, findChangedSpecPaths } from "../packages/factory-runner/src/spec-controller/analyze-pr.js";
import type { FeatureSpec } from "@darkfactory/contracts";

const GOOD_SPEC: FeatureSpec = {
  specId: "SPEC-ANALYZE-1",
  title: "Analyze spec",
  source: "human",
  owner: "@maintainer",
  status: "Draft",
  decision: "pending",
  intent: "A long enough intent statement to satisfy critic checks and support ready decisions.",
  scenarios: [
    { id: "SCN-ANALYZE-1", description: "scenario one", required: true },
    { id: "SCN-ANALYZE-2", description: "scenario two", required: true }
  ],
  verification: [
    { scenarioId: "SCN-ANALYZE-1", checks: ["unit"] },
    { scenarioId: "SCN-ANALYZE-2", checks: ["e2e"] }
  ],
  riskNotes: "Risk: regressions. Mitigation: automated tests and review.",
  createdAt: "2026-03-08T00:00:00.000Z",
  updatedAt: "2026-03-08T00:00:00.000Z"
};

test("findChangedSpecPaths filters only valid spec files", () => {
  const paths = findChangedSpecPaths([
    { filename: "specs/SPEC-0001.json", status: "modified" },
    { filename: "specs/SPEC-TEMPLATE.json", status: "modified" },
    { filename: "README.md", status: "modified" }
  ]);
  assert.deepEqual(paths, ["specs/SPEC-0001.json"]);
});

test("analyzeSpec promotes Draft to Refined when blockers are absent", () => {
  const analysis = analyzeSpec(GOOD_SPEC, "specs/SPEC-ANALYZE-1.json", "2026-03-08T03:00:00.000Z");
  assert.equal(analysis.nextStatus, "Refined");
  assert.equal(analysis.readiness, "ready-for-decision");
  assert.equal(analysis.changed, true);
});

test("analyzeSpec keeps status when validation fails", () => {
  const invalid: FeatureSpec = {
    ...GOOD_SPEC,
    verification: []
  };
  const analysis = analyzeSpec(invalid, "specs/SPEC-ANALYZE-1.json");
  assert.equal(analysis.nextStatus, "Draft");
  assert.equal(analysis.readiness, "needs-refinement");
});
