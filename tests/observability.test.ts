import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createTempWorkspace, runScript, REPO_ROOT } from "./helpers.js";

const REPORT_SCRIPT = join(REPO_ROOT, "dist/packages/factory-runner/src/reports.js");
const PROPOSAL_SCRIPT = join(REPO_ROOT, "dist/packages/factory-runner/src/proposals.js");

test("reports and feature proposals are generated from unified event ledger", async () => {
  const workspace = await createTempWorkspace();
  const ledgerPath = join(workspace, "var/ledger/events.ndjson");

  const seedEvents = [
    {
      specversion: "1.0",
      id: "1",
      source: "tests.observability",
      type: "game_event",
      time: "2026-03-07T01:00:00.000Z",
      datacontenttype: "application/json",
      data: {
        action: "match_created",
        actor: "system",
        specId: "SPEC-UNBOUND",
        scenarioId: "SCN-UNBOUND",
        deployId: "DEPLOY-UNBOUND",
        matchId: "match-001",
        metadata: {}
      }
    },
    {
      specversion: "1.0",
      id: "2",
      source: "tests.observability",
      type: "game_event",
      time: "2026-03-07T01:10:00.000Z",
      datacontenttype: "application/json",
      data: {
        action: "match_ended",
        actor: "system",
        specId: "SPEC-UNBOUND",
        scenarioId: "SCN-UNBOUND",
        deployId: "DEPLOY-UNBOUND",
        matchId: "match-001",
        metadata: {}
      }
    },
    {
      specversion: "1.0",
      id: "3",
      source: "tests.observability",
      type: "user_feedback",
      time: "2026-03-07T01:15:00.000Z",
      datacontenttype: "application/json",
      data: {
        action: "feedback_submitted",
        actor: "player-1",
        specId: "SPEC-UNBOUND",
        scenarioId: "SCN-UNBOUND",
        deployId: "DEPLOY-UNBOUND",
        matchId: "match-001",
        metadata: { message: "add replays and better wind indicators" }
      }
    },
    {
      specversion: "1.0",
      id: "4",
      source: "tests.observability",
      type: "pipeline_event",
      time: "2026-03-07T01:20:00.000Z",
      datacontenttype: "application/json",
      data: {
        action: "spec_rollback",
        actor: "deployer_agent",
        specId: "SPEC-001",
        scenarioId: "SCN-001",
        deployId: "DEPLOY-001",
        matchId: "match-unbound",
        metadata: { reason: "canary failed" }
      }
    },
    {
      specversion: "1.0",
      id: "5",
      source: "tests.observability",
      type: "incident",
      time: "2026-03-07T01:21:00.000Z",
      datacontenttype: "application/json",
      data: {
        action: "rollback_triggered",
        actor: "deployer_agent",
        specId: "SPEC-001",
        scenarioId: "SCN-001",
        deployId: "DEPLOY-001",
        matchId: "match-unbound",
        metadata: { reason: "canary failed" }
      }
    }
  ];

  await writeFile(ledgerPath, `${seedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  await runScript(REPORT_SCRIPT, [], { cwd: workspace, env: { LEDGER_PATH: ledgerPath } });
  await runScript(PROPOSAL_SCRIPT, [], { cwd: workspace, env: { LEDGER_PATH: ledgerPath } });

  const gameHealth = await readFile(join(workspace, "reports/game-health.md"), "utf8");
  const factoryHealth = await readFile(join(workspace, "reports/factory-health.md"), "utf8");
  const proposals = await readFile(join(workspace, "reports/feature-proposals.md"), "utf8");

  assert.match(gameHealth, /Matches created: 1/);
  assert.match(gameHealth, /Completion rate: 100.0%/);
  assert.match(factoryHealth, /Rollbacks: 1/);
  assert.match(proposals, /Weekly Feature Proposals/);
  assert.match(proposals, /Confidence:/);
});
