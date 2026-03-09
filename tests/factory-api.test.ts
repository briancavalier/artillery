import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudEventEnvelope } from "@darkfactory/contracts";
import { createFactoryStore } from "../apps/factory-api/src/storage.js";

test("factory store ingests CloudEvents and reports centralized admin status", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-api-"));
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.FACTORY_STATE_PATH = join(workspace, "state.json");
  delete process.env.FACTORY_DATABASE_URL;

  const store = await createFactoryStore();

  try {
    const deployedEvent: CloudEventEnvelope<Record<string, unknown>> = {
      specversion: "1.0",
      id: "evt-1",
      source: "test",
      type: "pipeline_event",
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      data: {
        action: "spec_deployed",
        actor: "deployer_agent",
        specId: "SPEC-API-1",
        scenarioId: "SCN-API-1",
        deployId: "DEPLOY-API-1",
        matchId: "MATCH-API-1",
        metadata: {}
      }
    };

    const gameEvents: Array<CloudEventEnvelope<Record<string, unknown>>> = [
      {
        specversion: "1.0",
        id: "evt-2",
        source: "test",
        type: "game_event",
        time: new Date().toISOString(),
        datacontenttype: "application/json",
        data: {
          action: "match_created",
          actor: "system",
          specId: "SPEC-UNBOUND",
          scenarioId: "SCN-0001",
          deployId: "DEPLOY-GAME-1",
          matchId: "MATCH-API-1",
          metadata: {}
        }
      },
      {
        specversion: "1.0",
        id: "evt-3",
        source: "test",
        type: "game_event",
        time: new Date().toISOString(),
        datacontenttype: "application/json",
        data: {
          action: "player_joined",
          actor: "system",
          specId: "SPEC-UNBOUND",
          scenarioId: "SCN-0001",
          deployId: "DEPLOY-GAME-1",
          matchId: "MATCH-API-1",
          metadata: {}
        }
      },
      {
        specversion: "1.0",
        id: "evt-4",
        source: "test",
        type: "game_event",
        time: new Date().toISOString(),
        datacontenttype: "application/json",
        data: {
          action: "match_ended",
          actor: "system",
          specId: "SPEC-UNBOUND",
          scenarioId: "SCN-0001",
          deployId: "DEPLOY-GAME-1",
          matchId: "MATCH-API-1",
          metadata: {}
        }
      }
    ];

    for (const event of [deployedEvent, ...gameEvents]) {
      await store.ingest(event);
    }

    const factoryBody = await store.getFactoryStatus();
    assert.equal(factoryBody.pipeline.deploymentsToday, 1);

    const eventsBody = { events: await store.getEvents({ type: "game_event", matchId: "MATCH-API-1", limit: 10, order: "asc" }) };
    assert.equal(eventsBody.events.length, 3);
    assert.equal(eventsBody.events[0]?.data.action, "match_created");

    const agents = await store.getAgentStatus();
    assert.equal(typeof agents.acceptanceRate, "number");

    const healthBody = await store.getProjectHealth();
    assert.equal(healthBody.metrics.matchesCreated, 1);
    assert.equal(healthBody.metrics.completionRate, 1);

    const canaryBody = await store.getProjectCanary();
    assert.equal(canaryBody.pass, true);

    const verifyBody = await store.verifyScenario("SCN-0001");
    assert.equal(verifyBody.passed, true);

    const queued = await store.enqueueImplementationTask({
      specId: "SPEC-API-1",
      source: "human",
      owner: "@maintainer",
      repo: "owner/repo",
      baseBranch: "main",
      baseSha: "abc123",
      targetBranch: "codex/implement-spec-api-1",
      allowedPaths: ["apps/artillery-game/**"],
      verificationTargets: ["SCN-0001"],
      contextBundleRef: "reports/implementation-context/SPEC-API-1.md",
      priority: 100,
      limits: { maxTurns: 4, maxDurationMs: 1000, maxCostUsd: 1, maxFilesChanged: 10 },
      policy: { allowAutoMerge: true, allowShell: true, allowNetwork: false, blockedPaths: ["packages/factory-core/**"] }
    });
    assert.equal(queued.status, "queued");

    const leased = await store.leaseImplementationTask();
    assert.equal(leased?.taskId, queued.taskId);
    assert.equal(leased?.status, "running");

    await store.writeImplementationRun({
      runId: "run-1",
      taskId: queued.taskId,
      provider: "dummy",
      model: "dummy-model",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: "pr_opened",
      usage: { inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.01 }
    });
    await store.writeImplementationArtifact({
      runId: "run-1",
      taskId: queued.taskId,
      prNumber: 7,
      prUrl: "https://example.test/pr/7",
      branch: "codex/implement-spec-api-1",
      commitSha: "deadbeef",
      filesChanged: ["apps/artillery-game/src/shared/simulation.ts"],
      testSummary: { passed: 1, failed: 0 },
      evidenceRefs: [],
      summaryMd: "summary"
    });

    const storedRun = await store.getImplementationRun("run-1");
    const storedArtifact = await store.getImplementationArtifact("run-1");
    assert.equal(storedRun?.provider, "dummy");
    assert.equal(storedArtifact?.prNumber, 7);

    const architectureTask = await store.enqueueArchitectureTask({
      specId: "SPEC-API-1",
      source: "human",
      owner: "@maintainer",
      repo: "owner/repo",
      baseBranch: "main",
      baseSha: "abc123",
      targetBranch: "codex/architect-spec-api-1",
      artifactRoot: "architecture/SPEC-API-1",
      contextBundleRef: "reports/architecture-context/SPEC-API-1.md",
      priority: 100,
      limits: { maxDurationMs: 1000, maxCostUsd: 1 },
      policy: { allowAutoMerge: true, blockedPaths: ["apps/artillery-game/**"] }
    });
    assert.equal(architectureTask.status, "queued");
    const leasedArchitecture = await store.leaseArchitectureTask();
    assert.equal(leasedArchitecture?.taskId, architectureTask.taskId);
    assert.equal(leasedArchitecture?.status, "running");
    await store.writeArchitectureRun({
      runId: "arch-run-1",
      taskId: architectureTask.taskId,
      provider: "dummy-architect",
      model: "dummy-model",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: "pr_opened",
      usage: { inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.01 }
    });
    await store.writeArchitectureArtifact({
      runId: "arch-run-1",
      taskId: architectureTask.taskId,
      prNumber: 8,
      prUrl: "https://example.test/pr/8",
      branch: "codex/architect-spec-api-1",
      commitSha: "c0ffee",
      filesChanged: ["architecture/SPEC-API-1/README.md"],
      summaryMd: "summary",
      payload: {
        readme: "Architecture summary",
        integrationPoints: [{ path: "apps/artillery-game/src/shared/simulation.ts", role: "simulation", writeIntent: "edit", priority: 1 }],
        invariants: ["Keep deterministic state hashing stable."],
        scenarioTrace: [{ scenarioId: "SCN-API-1", filePaths: ["apps/artillery-game/src/shared/simulation.ts"], evidenceHooks: ["integration"] }]
      }
    });
    const storedArchitectureRun = await store.getArchitectureRun("arch-run-1");
    const storedArchitectureArtifact = await store.getArchitectureArtifact("arch-run-1");
    assert.equal(storedArchitectureRun?.provider, "dummy-architect");
    assert.equal(storedArchitectureArtifact?.prNumber, 8);
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.FACTORY_STATE_PATH;
  }
});
