import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createTempWorkspace, readJson, writeJson } from "./helpers.js";
import { createArtilleryAdapter } from "../packages/project-adapter-artillery/src/index.js";
import { createFactoryStore } from "../apps/factory-api/src/storage.js";
import { runSpecExecution } from "../packages/factory-runner/src/spec-execution/controller.js";
import type {
  FeatureSpec,
  ImplementationArtifact,
  ImplementationPlanArtifact,
  ImplementationPlanSlice,
  ImplementationPlanningRun,
  ImplementationRun,
  ImplementationTask
} from "@darkfactory/contracts";
import type { ImplementationProvider } from "@darkfactory/core";

function createDiscoveryTrace() {
  return {
    searchedFiles: [
      "apps/artillery-game/src/shared/simulation.ts",
      "tests/determinism.test.ts"
    ],
    readFiles: [
      "apps/artillery-game/src/shared/simulation.ts",
      "tests/determinism.test.ts"
    ],
    selectedContextFiles: [
      "apps/artillery-game/src/shared/simulation.ts",
      "tests/determinism.test.ts"
    ],
    selectionReasons: {
      "apps/artillery-game/src/shared/simulation.ts": "seed file",
      "tests/determinism.test.ts": "path matches keywords: determin"
    },
    budgetUsed: {
      files: 2,
      bytes: 128
    }
  };
}

class DummyProvider implements ImplementationProvider {
  private readonly planningRuns = new Map<string, ImplementationPlanningRun>();
  private readonly plans = new Map<string, ImplementationPlanArtifact>();
  private readonly runs = new Map<string, ImplementationRun>();
  private readonly artifacts = new Map<string, ImplementationArtifact>();

  constructor(
    private readonly config: {
      filesChanged: string[];
      slices?: ImplementationPlanSlice[];
      planBlockedReason?: string;
    }
  ) {}

  async planTask(task: ImplementationTask): Promise<ImplementationPlanningRun> {
    const runId = `plan-${task.specId}`;
    const plan = this.buildPlan(task, runId);
    const run: ImplementationPlanningRun = {
      runId,
      taskId: task.taskId,
      provider: "dummy",
      model: "dummy-model",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: plan.blockedReason ? "blocked" : "planned",
      usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
      summary: plan.blockedReason ? `Blocked: ${plan.blockedReason}` : "plan ready",
      discovery: createDiscoveryTrace(),
      metadata: {
        requestDiagnostics: { attempts: [{ attempt: 1 }] }
      }
    };
    this.planningRuns.set(runId, run);
    this.plans.set(runId, plan);
    return run;
  }

  async getPlanningRun(runId: string): Promise<ImplementationPlanningRun | null> {
    return this.planningRuns.get(runId) ?? null;
  }

  async collectPlanArtifact(runId: string): Promise<ImplementationPlanArtifact | null> {
    return this.plans.get(runId) ?? null;
  }

  async implementSlice(task: ImplementationTask, _plan: ImplementationPlanArtifact, sliceId: string): Promise<ImplementationRun> {
    const runId = `run-${task.specId}-${sliceId}`;
    const run: ImplementationRun = {
      runId,
      taskId: task.taskId,
      provider: "dummy",
      model: "dummy-model",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: "pr_opened",
      usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
      summary: "dummy run",
      traceId: `trace-${sliceId}`,
      discovery: createDiscoveryTrace(),
      metadata: {
        requestDiagnostics: { attempts: [{ attempt: 1 }] }
      }
    };
    const artifact: ImplementationArtifact = {
      runId,
      taskId: task.taskId,
      prNumber: 7,
      prUrl: "https://example.test/pr/7",
      branch: "codex/implement-spec-exec-1",
      commitSha: "abc123",
      filesChanged: this.config.filesChanged,
      testSummary: { passed: 0, failed: 0, command: "dummy" },
      evidenceRefs: [],
      summaryMd: "dummy artifact",
      sliceId,
      discovery: createDiscoveryTrace()
    };
    this.runs.set(runId, run);
    this.artifacts.set(runId, artifact);
    return run;
  }

  async getRun(runId: string): Promise<ImplementationRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async cancelRun(): Promise<void> {}

  async collectArtifacts(runId: string): Promise<ImplementationArtifact | null> {
    return this.artifacts.get(runId) ?? null;
  }

  private buildPlan(task: ImplementationTask, runId: string): ImplementationPlanArtifact {
    const slices = this.config.slices ?? [
      {
        sliceId: "slice-1",
        title: "Single slice",
        goal: "Implement the required change in one bounded patch.",
        targetFiles: ["apps/artillery-game/src/shared/simulation.ts"],
        expectedTests: ["tests/determinism.test.ts"],
        expectedEvidence: task.verificationTargets,
        writeScope: task.allowedPaths,
        dependsOnSliceIds: []
      }
    ];
    return {
      runId,
      taskId: task.taskId,
      planId: `plan-${task.specId}`,
      specId: task.specId,
      summary: "Structured implementation plan",
      targetFiles: [...new Set(slices.flatMap((slice) => slice.targetFiles))],
      testFiles: [...new Set(slices.flatMap((slice) => slice.expectedTests))],
      evidenceTargets: [...new Set(slices.flatMap((slice) => slice.expectedEvidence))],
      slices,
      risks: ["Keep deterministic state hashing stable."],
      blockedReason: this.config.planBlockedReason,
      selectedContextFiles: createDiscoveryTrace().selectedContextFiles,
      metadata: {
        updatedAt: new Date().toISOString()
      }
    };
  }
}

class FailingProvider extends DummyProvider {
  constructor() {
    super({ filesChanged: ["apps/artillery-game/src/shared/simulation.ts"] });
  }

  override async implementSlice(task: ImplementationTask, _plan: ImplementationPlanArtifact, sliceId: string): Promise<ImplementationRun> {
    return {
      runId: `run-${task.specId}-${sliceId}`,
      taskId: task.taskId,
      provider: "dummy",
      model: "dummy-model",
      status: "failed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: "failed",
      usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
      summary: "synthetic provider failure",
      traceId: "trace-failed-run",
      discovery: createDiscoveryTrace(),
      metadata: {
        requestDiagnostics: { attempts: [{ attempt: 1 }] }
      }
    };
  }

  override async collectArtifacts(): Promise<ImplementationArtifact | null> {
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

async function writeArchitectureArtifacts(workspace: string, specId: string, scenarioIds: string[]): Promise<void> {
  const dir = join(workspace, "architecture", specId);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "integration-points.json"), [
    { path: "apps/artillery-game/src/shared/simulation.ts", role: "simulation", writeIntent: "edit", priority: 1 },
    { path: "tests/determinism.test.ts", role: "determinism coverage", writeIntent: "read-only", priority: 2 }
  ]);
  await writeJson(join(dir, "invariants.json"), [
    { id: "INV-1", description: "Keep deterministic state hashing stable.", category: "determinism" },
    { id: "INV-2", description: "Preserve required scenario evidence hooks.", category: "testing" }
  ]);
  await writeJson(join(dir, "scenario-trace.json"), scenarioIds.map((scenarioId) => ({
    scenarioId,
    paths: ["apps/artillery-game/src/shared/simulation.ts"],
    evidenceHooks: ["integration"]
  })));
  await writeFile(join(dir, "README.md"), "# Architecture\n", "utf8");
}

function createAdapter(workspace: string) {
  return createArtilleryAdapter({
    specDir: join(workspace, "specs"),
    evidenceDir: join(workspace, "evidence"),
    ledgerPath: join(workspace, "var/ledger/events.ndjson"),
    evaluationsDir: join(workspace, "reports/evaluations"),
    canaryPath: join(workspace, "ops/canary/latest.json"),
    dryRun: false,
    localEventMode: true
  } as never);
}

test("execution controller plans and verifies a single-slice architected spec", async () => {
  const workspace = await createTempWorkspace();
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.FACTORY_STATE_PATH = join(workspace, "var/factory/state.json");
  process.env.IMPLEMENTATION_TEST_MODE = "1";

  try {
    await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Architected", ["SCN-0001", "SCN-0002", "SCN-0003"]));
    await writeArchitectureArtifacts(workspace, "SPEC-EXEC-1", ["SCN-0001", "SCN-0002", "SCN-0003"]);
    const adapter = createAdapter(workspace);
    const store = await createFactoryStore();

    const result = await runSpecExecution({
      adapter,
      store,
      provider: new DummyProvider({ filesChanged: ["apps/artillery-game/src/shared/simulation.ts"] }),
      owner: "owner",
      repo: "repo",
      baseBranch: "main",
      commitSha: "base-sha",
      reportRootDir: workspace
    });

    assert.equal(result.manifest.queued.length, 1);
    assert.equal(result.manifest.advanced[0]?.taskStatus, "merged");
    const contextBundle = await readFile(join(workspace, "reports/implementation-context/SPEC-EXEC-1.md"), "utf8");
    assert.match(contextBundle, /# Accepted Spec SPEC-EXEC-1/);
    const stored = await readJson<{ status: string }>(join(workspace, "specs/SPEC-EXEC-1.json"));
    assert.equal(stored.status, "Verified");
    const plan = await readJson<{ slices: unknown[] }>(join(workspace, "implementation-plans/SPEC-EXEC-1/plan.json"));
    assert.equal(plan.slices.length, 1);
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.FACTORY_STATE_PATH;
    delete process.env.IMPLEMENTATION_TEST_MODE;
  }
});

test("execution controller skips approved specs until architecture artifacts exist", async () => {
  const workspace = await createTempWorkspace();
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.FACTORY_STATE_PATH = join(workspace, "var/factory/state.json");
  process.env.IMPLEMENTATION_TEST_MODE = "1";

  try {
    await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Approved", ["SCN-0001"]));
    const adapter = createAdapter(workspace);
    const store = await createFactoryStore();

    const result = await runSpecExecution({
      adapter,
      store,
      provider: new DummyProvider({ filesChanged: ["apps/artillery-game/src/shared/simulation.ts"] }),
      owner: "owner",
      repo: "repo",
      baseBranch: "main",
      commitSha: "base-sha",
      reportRootDir: workspace
    });

    assert.equal(result.manifest.queued.length, 0);
    assert.equal(result.manifest.advanced.length, 0);
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
    await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Architected", ["SCN-0001"]));
    await writeArchitectureArtifacts(workspace, "SPEC-EXEC-1", ["SCN-0001"]);
    const adapter = createAdapter(workspace);
    const store = await createFactoryStore();

    const result = await runSpecExecution({
      adapter,
      store,
      provider: new DummyProvider({ filesChanged: ["packages/factory-core/src/engine.ts"] }),
      owner: "owner",
      repo: "repo",
      baseBranch: "main",
      commitSha: "base-sha",
      reportRootDir: workspace
    });

    assert.equal(result.manifest.advanced[0]?.taskStatus, "blocked");
    const stored = await readJson<{ status: string }>(join(workspace, "specs/SPEC-EXEC-1.json"));
    assert.equal(stored.status, "Architected");
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
    await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Architected", ["SCN-0301", "SCN-0302"]));
    await writeArchitectureArtifacts(workspace, "SPEC-EXEC-1", ["SCN-0301", "SCN-0302"]);
    const adapter = createAdapter(workspace);
    const store = await createFactoryStore();

    const result = await runSpecExecution({
      adapter,
      store,
      provider: new DummyProvider({ filesChanged: ["apps/artillery-game/src/shared/simulation.ts"] }),
      owner: "owner",
      repo: "repo",
      baseBranch: "main",
      commitSha: "base-sha",
      reportRootDir: workspace
    });

    assert.equal(result.manifest.advanced[0]?.taskStatus, "blocked");
    assert.match(result.manifest.advanced[0]?.blockedReason ?? "", /Required scenario evidence missing or failed/);
    const stored = await readJson<{ status: string }>(join(workspace, "specs/SPEC-EXEC-1.json"));
    assert.equal(stored.status, "Architected");
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
    await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Architected", ["SCN-0001"]));
    await writeArchitectureArtifacts(workspace, "SPEC-EXEC-1", ["SCN-0001"]);
    const adapter = createAdapter(workspace);
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
    const stored = await readJson<{ status: string }>(join(workspace, "specs/SPEC-EXEC-1.json"));
    assert.equal(stored.status, "Architected");
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.FACTORY_STATE_PATH;
    delete process.env.IMPLEMENTATION_TEST_MODE;
  }
});

test("execution controller processes only the first slice and queues the next one", async () => {
  const workspace = await createTempWorkspace();
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.FACTORY_STATE_PATH = join(workspace, "var/factory/state.json");
  process.env.IMPLEMENTATION_TEST_MODE = "1";

  try {
    await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Architected", ["SCN-0001"]));
    await writeArchitectureArtifacts(workspace, "SPEC-EXEC-1", ["SCN-0001"]);
    const adapter = createAdapter(workspace);
    const store = await createFactoryStore();
    const provider = new DummyProvider({
      filesChanged: ["apps/artillery-game/src/shared/simulation.ts"],
      slices: [
        {
          sliceId: "slice-1",
          title: "Terrain model",
          goal: "Add terrain state types.",
          targetFiles: ["apps/artillery-game/src/shared/simulation.ts"],
          expectedTests: ["tests/determinism.test.ts"],
          expectedEvidence: ["SCN-0001"],
          writeScope: ["apps/artillery-game/**", "tests/**"],
          dependsOnSliceIds: []
        },
        {
          sliceId: "slice-2",
          title: "Rendering",
          goal: "Render terrain.",
          targetFiles: ["apps/artillery-game/src/client/main.ts"],
          expectedTests: ["tests/protocol.test.ts"],
          expectedEvidence: ["SCN-0001"],
          writeScope: ["apps/artillery-game/**", "tests/**"],
          dependsOnSliceIds: ["slice-1"]
        }
      ]
    });

    const result = await runSpecExecution({
      adapter,
      store,
      provider,
      owner: "owner",
      repo: "repo",
      baseBranch: "main",
      commitSha: "base-sha",
      reportRootDir: workspace
    });

    assert.equal(result.manifest.advanced[0]?.taskStatus, "merged");
    const tasks = await store.listImplementationTasks();
    assert.equal(tasks.length, 2);
    const followUp = tasks.find((task) => task.sliceId === "slice-2");
    assert.equal(followUp?.status, "queued");
    const stored = await readJson<{ status: string }>(join(workspace, "specs/SPEC-EXEC-1.json"));
    assert.equal(stored.status, "Architected");
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.FACTORY_STATE_PATH;
    delete process.env.IMPLEMENTATION_TEST_MODE;
  }
});
