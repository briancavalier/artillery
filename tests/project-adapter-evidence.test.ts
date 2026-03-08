import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createTempWorkspace, readJson } from "./helpers.js";
import { generateArtilleryScenarioEvidence } from "../packages/project-adapter-artillery/src/evidence.js";
import type { FeatureSpec } from "@darkfactory/contracts";

function makeSpec(scenarios: string[]): FeatureSpec {
  return {
    specId: "SPEC-EVIDENCE-1",
    title: "Evidence generator",
    source: "human",
    owner: "@maintainer",
    status: "Implemented",
    decision: "accept",
    intent: "Exercise the project adapter evidence generator with supported and unsupported scenarios.",
    scenarios: scenarios.map((scenarioId) => ({
      id: scenarioId,
      description: `Scenario ${scenarioId}`,
      required: true
    })),
    verification: scenarios.map((scenarioId) => ({
      scenarioId,
      checks: ["integration"]
    })),
    riskNotes: "Risk: false confidence. Mitigation: write explicit evidence files for each required scenario.",
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z"
  };
}

test("artillery adapter generates passing evidence for supported scenarios", async () => {
  const workspace = await createTempWorkspace();
  const spec = makeSpec(["SCN-0001", "SCN-0002", "SCN-0003"]);

  const evidence = await generateArtilleryScenarioEvidence(spec, {
    evidenceDir: join(workspace, "evidence"),
    ledgerPath: join(workspace, "var/ledger/events.ndjson"),
    deployId: "deploy-evidence"
  });

  assert.equal(evidence.length, 3);
  assert.equal(evidence.every((entry) => entry.passed), true);

  const stored = await readJson<{ passed: boolean }>(join(workspace, "evidence", spec.specId, "SCN-0003.json"));
  assert.equal(stored.passed, true);
});

test("artillery adapter records unsupported scenarios as failed evidence", async () => {
  const workspace = await createTempWorkspace();
  const spec = makeSpec(["SCN-0999"]);

  const evidence = await generateArtilleryScenarioEvidence(spec, {
    evidenceDir: join(workspace, "evidence"),
    ledgerPath: join(workspace, "var/ledger/events.ndjson"),
    deployId: "deploy-evidence"
  });

  assert.equal(evidence[0]?.passed, false);
  const stored = await readJson<{ details: { reason: string } }>(join(workspace, "evidence", spec.specId, "SCN-0999.json"));
  assert.match(stored.details.reason, /No project adapter verifier/);
});
