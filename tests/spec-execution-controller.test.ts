import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createTempWorkspace, readJson, writeJson } from "./helpers.js";
import { createArtilleryAdapter } from "../packages/project-adapter-artillery/src/index.js";
import { createFactoryStore } from "../apps/factory-api/src/storage.js";
import { runSpecExecution } from "../packages/factory-runner/src/spec-execution/controller.js";
import type { FeatureSpec, ImplementationArtifact, ImplementationRun, ImplementationTask } from "@darkfactory/contracts";
import type { ImplementationProvider } from "@darkfactory/core";

class DummyProvider implements ImplementationProvider {
  constructor(private readonly filesChanged: string[]) {}

  async startTask(task: ImplementationTask): Promise<ImplementationRun> {
    return {
      runId: `run-${task.specId}`,
      taskId: task.taskId,
      provider: "dummy",
      model: "dummy-model",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: "pr_opened",
      usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
      summary: "dummy run"
    };
  }

  async getRun(runId: string): Promise<ImplementationRun | null> {
    return null;
  }

  async cancelRun(): Promise<void> {}

  async collectArtifacts(runId: string): Promise<ImplementationArtifact | null> {
    return {
      runId,
      taskId: runId.replace("run-", "task-"),
      prNumber: 7,
      prUrl: "https://example.test/pr/7",
      branch: "codex/implement-spec-exec-1",
      commitSha: "abc123",
      filesChanged: this.filesChanged,
      testSummary: { passed: 0, failed: 0, command: "dummy" },
      evidenceRefs: [],
      summaryMd: "dummy artifact"
    };
  }
}

class FailingProvider implements ImplementationProvider {
  async startTask(task: ImplementationTask): Promise<ImplementationRun> {
    return {
      runId: `run-${task.specId}`,
      taskId: task.taskId,
      provider: "dummy",
      model: "dummy-model",
      status: "failed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: "failed",
      usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
      summary: "synthetic provider failure",
      traceId: "trace-failed-run"
    };
  }

  async getRun(): Promise<ImplementationRun | null> {
    return null;
  }

  async cancelRun(): Promise<void> {}

  async collectArtifacts(): Promise<ImplementationArtifact | null> {
    return null;
  }
}

function makeSpec(status: FeatureSpec["status"], scenarioIds: string[]): FeatureSpec {
  return {
    specId: "SPEC-EXEC-1",
    title: "Execution controller",
    source: "human",
    owner: "@maintainer",
    status,
    decision: "accept",
    intent: "Advance accepted specs through implementation and verification when adapter evidence can prove the scenarios.",
    scenarios: scenarioIds.map((id) => ({ id, description: `Scenario ${id}`, required: true })),
    verification: scenarioIds.map((id) => ({ scenarioId: id, checks: ["integration"] })),
    riskNotes: "Risk: unsupported scenarios stall. Mitigation: preserve failed evidence rather than promoting the spec.",
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z"
  };
}

test("execution controller enqueues and verifies supported approved specs", async () => {
  const workspace = await createTempWorkspace();
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.FACTORY_STATE_PATH = join(workspace, "var/factory/state.json");
  process.env.IMPLEMENTATION_TEST_MODE = "1";

  try {
    await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Approved", ["SCN-0001", "SCN-0002", "SCN-0003"]));
    const adapter = createArtilleryAdapter({
      specDir: join(workspace, "specs"),
      evidenceDir: join(workspace, "evidence"),
      ledgerPath: join(workspace, "var/ledger/events.ndjson"),
      evaluationsDir: join(workspace, "reports/evaluations"),
      canaryPath: join(workspace, "ops/canary/latest.json"),
      dryRun: false,
      localEventMode: true
    } as never);
    const store = await createFactoryStore();

    const result = await runSpecExecution({
      adapter,
      store,
      provider: new DummyProvider(["apps/artillery-game/src/shared/simulation.ts"]),
      owner: "owner",
      repo: "repo",
      baseBranch: "main",
      commitSha: "base-sha",
      reportRootDir: workspace
    });

    assert.equal(result.manifest.queued.length, 1);
    assert.equal(result.manifest.advanced[0]?.taskStatus, "merged");
    const stored = await readJson<{ status: string }>(join(workspace, "specs/SPEC-EXEC-1.json"));
    assert.equal(stored.status, "Verified");
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.FACTORY_STATE_PATH;
    delete process.env.IMPLEMENTATION_TEST_MODE;
  }
});

test("execution controller blocks artifacts outside implementation allowlist", async () => {
  const workspace = await createTempWorkspace();
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.FACTORY_STATE_PATH = join(workspace, "var/factory/state.json");
  process.env.IMPLEMENTATION_TEST_MODE = "1";

  try {
    await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Approved", ["SCN-0001"]));
    const adapter = createArtilleryAdapter({
      specDir: join(workspace, "specs"),
      evidenceDir: join(workspace, "evidence"),
      ledgerPath: join(workspace, "var/ledger/events.ndjson"),
      evaluationsDir: join(workspace, "reports/evaluations"),
      canaryPath: join(workspace, "ops/canary/latest.json"),
      dryRun: false,
      localEventMode: true
    } as never);
    const store = await createFactoryStore();

    const result = await runSpecExecution({
      adapter,
      store,
      provider: new DummyProvider(["packages/factory-core/src/engine.ts"]),
      owner: "owner",
      repo: "repo",
      baseBranch: "main",
      commitSha: "base-sha",
      reportRootDir: workspace
    });

    assert.equal(result.manifest.advanced[0]?.taskStatus, "blocked");
    const stored = await readJson<{ status: string }>(join(workspace, "specs/SPEC-EXEC-1.json"));
    assert.equal(stored.status, "Approved");
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.FACTORY_STATE_PATH;
    delete process.env.IMPLEMENTATION_TEST_MODE;
  }
});

test("execution controller does not merge when required evidence fails", async () => {
  const workspace = await createTempWorkspace();
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.FACTORY_STATE_PATH = join(workspace, "var/factory/state.json");
  process.env.IMPLEMENTATION_TEST_MODE = "1";

  try {
    await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Approved", ["SCN-0301", "SCN-0302"]));
    const adapter = createArtilleryAdapter({
      specDir: join(workspace, "specs"),
      evidenceDir: join(workspace, "evidence"),
      ledgerPath: join(workspace, "var/ledger/events.ndjson"),
      evaluationsDir: join(workspace, "reports/evaluations"),
      canaryPath: join(workspace, "ops/canary/latest.json"),
      dryRun: false,
      localEventMode: true
    } as never);
    const store = await createFactoryStore();

    const result = await runSpecExecution({
      adapter,
      store,
      provider: new DummyProvider(["apps/artillery-game/src/shared/simulation.ts"]),
      owner: "owner",
      repo: "repo",
      baseBranch: "main",
      commitSha: "base-sha",
      reportRootDir: workspace
    });

    assert.equal(result.manifest.advanced[0]?.taskStatus, "blocked");
    assert.match(result.manifest.advanced[0]?.blockedReason ?? "", /Required scenario evidence missing or failed/);
    assert.equal(result.manifest.advanced[0]?.pullRequestNumber, 7);
    const stored = await readJson<{ status: string }>(join(workspace, "specs/SPEC-EXEC-1.json"));
    assert.equal(stored.status, "Approved");
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.FACTORY_STATE_PATH;
    delete process.env.IMPLEMENTATION_TEST_MODE;
  }
});

test("execution controller surfaces provider failure diagnostics in the manifest", async () => {
  const workspace = await createTempWorkspace();
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.FACTORY_STATE_PATH = join(workspace, "var/factory/state.json");
  process.env.IMPLEMENTATION_TEST_MODE = "1";

  try {
    await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Approved", ["SCN-0001"]));
    const adapter = createArtilleryAdapter({
      specDir: join(workspace, "specs"),
      evidenceDir: join(workspace, "evidence"),
      ledgerPath: join(workspace, "var/ledger/events.ndjson"),
      evaluationsDir: join(workspace, "reports/evaluations"),
      canaryPath: join(workspace, "ops/canary/latest.json"),
      dryRun: false,
      localEventMode: true
    } as never);
    const store = await createFactoryStore();

    const result = await runSpecExecution({
      adapter,
      store,
      provider: new FailingProvider(),
      owner: "owner",
      repo: "repo",
      baseBranch: "main",
      commitSha: "base-sha",
      reportRootDir: workspace
    });

    assert.equal(result.manifest.advanced[0]?.taskStatus, "failed");
    assert.equal(result.manifest.advanced[0]?.runStatus, "failed");
    assert.equal(result.manifest.advanced[0]?.runResult, "failed");
    assert.equal(result.manifest.advanced[0]?.traceId, "trace-failed-run");
    assert.equal(result.manifest.advanced[0]?.failureReason, "synthetic provider failure (artifact missing)");
    assert.equal(result.manifest.advanced[0]?.runSummary, "synthetic provider failure");
    const stored = await readJson<{ status: string }>(join(workspace, "specs/SPEC-EXEC-1.json"));
    assert.equal(stored.status, "Approved");
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.FACTORY_STATE_PATH;
    delete process.env.IMPLEMENTATION_TEST_MODE;
  }
});
