import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { createTempWorkspace, readJson, runScript, writeJson, REPO_ROOT } from "./helpers.js";

const FACTORY_SCRIPT = join(REPO_ROOT, "dist/packages/factory-runner/src/cli.js");
const SPEC_LINT_SCRIPT = join(REPO_ROOT, "dist/packages/factory-runner/src/spec-lint.js");

function makeSpec(specId: string, source: "human" | "agent") {
  return {
    specId,
    title: `Spec ${specId}`,
    source,
    owner: source === "human" ? "@maintainer" : "learning_agent",
    status: "Draft",
    decision: "pending",
    intent: "Implement deterministic behavior with explicit scenario checks and rollout safeguards.",
    scenarios: [
      { id: "SCN-1", description: "scenario one", required: true },
      { id: "SCN-2", description: "scenario two", required: true }
    ],
    verification: [
      { scenarioId: "SCN-1", checks: ["unit"] },
      { scenarioId: "SCN-2", checks: ["e2e"] }
    ],
    riskNotes: "Risk: behavior regressions. Mitigation: strict scenario evidence gate.",
    createdAt: "2026-03-07T00:00:00.000Z",
    updatedAt: "2026-03-07T00:00:00.000Z"
  };
}

test("human and agent specs follow same critique/evaluation/refinement flow", async () => {
  const workspace = await createTempWorkspace();
  const specHumanPath = join(workspace, "specs/SPEC-H-001.json");
  const specAgentPath = join(workspace, "specs/SPEC-A-001.json");

  await writeJson(specHumanPath, makeSpec("SPEC-H-001", "human"));
  await writeJson(specAgentPath, makeSpec("SPEC-A-001", "agent"));

  await runScript(SPEC_LINT_SCRIPT, [], {
    cwd: workspace,
    env: { SPEC_DIR: join(workspace, "specs") }
  });

  await runScript(FACTORY_SCRIPT, ["critic"], {
    cwd: workspace,
    env: { SPEC_DIR: join(workspace, "specs"), LEDGER_PATH: join(workspace, "var/ledger/events.ndjson") }
  });

  await runScript(FACTORY_SCRIPT, ["evaluate"], {
    cwd: workspace,
    env: { SPEC_DIR: join(workspace, "specs"), LEDGER_PATH: join(workspace, "var/ledger/events.ndjson") }
  });

  await runScript(FACTORY_SCRIPT, ["refine"], {
    cwd: workspace,
    env: { SPEC_DIR: join(workspace, "specs"), LEDGER_PATH: join(workspace, "var/ledger/events.ndjson") }
  });

  const human = await readJson<{ status: string }>(specHumanPath);
  const agent = await readJson<{ status: string }>(specAgentPath);
  assert.equal(human.status, "Refined");
  assert.equal(agent.status, "Refined");
});

test("maintainer controls enforce accept, veto, verify, deploy, rollback", async () => {
  const workspace = await createTempWorkspace();
  const specPath = join(workspace, "specs/SPEC-H-002.json");
  const ledgerPath = join(workspace, "var/ledger/events.ndjson");

  await writeJson(specPath, makeSpec("SPEC-H-002", "human"));

  await runScript(FACTORY_SCRIPT, ["critic"], { cwd: workspace, env: { SPEC_DIR: join(workspace, "specs"), LEDGER_PATH: ledgerPath, SPEC_ID: "SPEC-H-002" } });
  await runScript(FACTORY_SCRIPT, ["evaluate"], { cwd: workspace, env: { SPEC_DIR: join(workspace, "specs"), LEDGER_PATH: ledgerPath, SPEC_ID: "SPEC-H-002" } });
  await runScript(FACTORY_SCRIPT, ["refine"], { cwd: workspace, env: { SPEC_DIR: join(workspace, "specs"), LEDGER_PATH: ledgerPath, SPEC_ID: "SPEC-H-002" } });
  await runScript(FACTORY_SCRIPT, ["accept", "SPEC-H-002"], { cwd: workspace, env: { SPEC_DIR: join(workspace, "specs"), LEDGER_PATH: ledgerPath } });
  await runScript(FACTORY_SCRIPT, ["implement", "SPEC-H-002"], { cwd: workspace, env: { SPEC_DIR: join(workspace, "specs"), LEDGER_PATH: ledgerPath } });

  await mkdir(join(workspace, "evidence/SPEC-H-002"), { recursive: true });
  await writeJson(join(workspace, "evidence/SPEC-H-002/SCN-1.json"), { scenarioId: "SCN-1", passed: true });
  await writeJson(join(workspace, "evidence/SPEC-H-002/SCN-2.json"), { scenarioId: "SCN-2", passed: true });
  await writeJson(join(workspace, "ops/canary/latest.json"), { pass: true, metrics: { rejectRate: 0 } });

  await runScript(FACTORY_SCRIPT, ["verify", "SPEC-H-002"], { cwd: workspace, env: { SPEC_DIR: join(workspace, "specs"), LEDGER_PATH: ledgerPath } });
  await runScript(FACTORY_SCRIPT, ["deploy", "SPEC-H-002"], { cwd: workspace, env: { SPEC_DIR: join(workspace, "specs"), LEDGER_PATH: ledgerPath } });

  let spec = await readJson<{ status: string; decision: string }>(specPath);
  assert.equal(spec.status, "Deployed");
  assert.equal(spec.decision, "accept");

  await runScript(FACTORY_SCRIPT, ["rollback", "SPEC-H-002", "manual rollback for regression"], {
    cwd: workspace,
    env: { SPEC_DIR: join(workspace, "specs"), LEDGER_PATH: ledgerPath }
  });

  spec = await readJson(specPath);
  assert.equal(spec.status, "Refined");
  assert.equal(spec.decision, "rollback");

  const ledger = await readFile(ledgerPath, "utf8");
  assert.match(ledger, /"action":"spec_accepted"/);
  assert.match(ledger, /"action":"spec_rollback"/);
  assert.match(ledger, /"type":"incident"/);
});
