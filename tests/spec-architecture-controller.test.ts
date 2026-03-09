import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeJson, createTempWorkspace, readJson } from "./helpers.js";
import { createArtilleryAdapter } from "../packages/project-adapter-artillery/src/index.js";
import { createFactoryStore } from "../apps/factory-api/src/storage.js";
import { runSpecArchitecture } from "../packages/factory-runner/src/spec-architecture/controller.js";
import type { ArchitectureArtifact, ArchitectureRun, ArchitectureTask, FeatureSpec } from "@darkfactory/contracts";
import type { ArchitectureProvider } from "@darkfactory/core";

class DummyArchitectureProvider implements ArchitectureProvider {
  async startTask(task: ArchitectureTask): Promise<ArchitectureRun> {
    return {
      runId: `arch-run-${task.specId}`,
      taskId: task.taskId,
      provider: "dummy-architect",
      model: "dummy-model",
      status: "completed",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: "pr_opened",
      usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
      summary: "Architecture summary",
      metadata: {
        selectedContextFiles: ["apps/artillery-game/src/shared/simulation.ts"],
        requestDiagnostics: { attempts: [{ attempt: 1 }] }
      }
    };
  }
  async getRun(): Promise<ArchitectureRun | null> { return null; }
  async cancelRun(): Promise<void> {}
  async collectArtifacts(runId: string): Promise<ArchitectureArtifact | null> {
    return {
      runId,
      taskId: "task",
      prNumber: 7,
      prUrl: "https://example.test/pr/7",
      branch: "codex/architect-spec-arch-1",
      commitSha: "abc123",
      filesChanged: [
        "architecture/SPEC-ARCH-1/README.md",
        "architecture/SPEC-ARCH-1/integration-points.json",
        "architecture/SPEC-ARCH-1/invariants.json",
        "architecture/SPEC-ARCH-1/scenario-trace.json"
      ],
      summaryMd: "Architecture summary",
      payload: {
        readme: "Architecture summary",
        integrationPoints: [{ path: "apps/artillery-game/src/shared/simulation.ts", role: "simulation", writeIntent: "edit", priority: 1 }],
        invariants: ["Keep deterministic state hashing stable."],
        scenarioTrace: [{ scenarioId: "SCN-ARCH-1", filePaths: ["apps/artillery-game/src/shared/simulation.ts"], evidenceHooks: ["integration"] }]
      }
    };
  }
}

function makeSpec(): FeatureSpec {
  return {
    specId: "SPEC-ARCH-1",
    title: "Architecture controller",
    source: "human",
    owner: "@maintainer",
    status: "Approved",
    decision: "accept",
    intent: "Produce architecture artifacts before implementation starts.",
    scenarios: [{ id: "SCN-ARCH-1", description: "Architecture coverage exists", required: true }],
    verification: [{ scenarioId: "SCN-ARCH-1", checks: ["artifact-validation"] }],
    riskNotes: "Risk: incomplete architecture guidance. Mitigation: block until scenario trace covers required scenarios.",
    createdAt: "2026-03-09T00:00:00.000Z",
    updatedAt: "2026-03-09T00:00:00.000Z"
  };
}

test("architecture controller advances approved specs to architected", async () => {
  const workspace = await createTempWorkspace();
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.FACTORY_STATE_PATH = join(workspace, "var/factory/state.json");
  process.env.ARCHITECTURE_TEST_MODE = "1";

  try {
    await writeJson(join(workspace, "specs/SPEC-ARCH-1.json"), makeSpec());
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

    const result = await runSpecArchitecture({
      adapter,
      store,
      provider: new DummyArchitectureProvider(),
      owner: "owner",
      repo: "repo",
      baseBranch: "main",
      commitSha: "base-sha",
      reportRootDir: workspace
    });

    assert.equal(result.manifest.queued.length, 1);
    assert.equal(result.manifest.advanced[0]?.taskStatus, "merged");
    const stored = await readJson<{ status: string }>(join(workspace, "specs/SPEC-ARCH-1.json"));
    assert.equal(stored.status, "Architected");
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.FACTORY_STATE_PATH;
    delete process.env.ARCHITECTURE_TEST_MODE;
  }
});
