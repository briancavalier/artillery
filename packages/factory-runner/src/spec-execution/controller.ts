import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createArtilleryAdapter } from "@darkfactory/project-adapter-artillery";
import { createFactoryStore, type FactoryStore } from "../../../../apps/factory-api/src/storage.js";
import {
  createCodexProvider,
  enqueueAcceptedSpecs,
  processImplementationQueue,
  type SpecExecutionOptions
} from "../../../../apps/factory-api/src/implementation.js";
import type { FactoryAdapter, ImplementationProvider } from "@darkfactory/core";
import type { ExecutionManifest } from "./types.js";

export interface RunSpecExecutionOptions {
  adapter?: FactoryAdapter;
  store?: FactoryStore;
  provider?: ImplementationProvider;
  owner?: string;
  repo?: string;
  baseBranch?: string;
  commitSha?: string;
  actor?: string;
  source?: string;
  deployId?: string;
  reportRootDir?: string;
}

export async function runSpecExecution(options: RunSpecExecutionOptions): Promise<{ manifest: ExecutionManifest }> {
  const owner = options.owner ?? "";
  const repo = options.repo ?? "";
  const adapter = options.adapter ?? createArtilleryAdapter();
  const store = options.store ?? await createFactoryStore();
  const executionOptions: SpecExecutionOptions = {
    actor: options.actor,
    source: options.source,
    deployId: options.deployId,
    repoFullName: owner && repo ? `${owner}/${repo}` : "",
    owner,
    repo,
    baseBranch: options.baseBranch ?? "main",
    baseSha: options.commitSha ?? "",
    reportRootDir: options.reportRootDir
  };

  const acceptedSpecs = await adapter.listSpecs();
  const previousStatusBySpec = new Map(
    acceptedSpecs
      .filter((spec) => spec.data.status === "Architected" && spec.data.decision === "accept")
      .map((spec) => [spec.data.specId, spec.data.status] as const)
  );
  const queued = await enqueueAcceptedSpecs(store, adapter, executionOptions);
  const provider = options.provider ?? (owner && repo ? createCodexProvider(owner, repo) : undefined);
  const processed = provider
    ? await processImplementationQueue(store, adapter, provider, executionOptions)
    : [];

  const advanced = [];
  for (const task of processed) {
    const spec = await adapter.readSpecById(task.specId);
    const run = task.runId ? await store.getImplementationRun(task.runId) : null;
    const artifact = task.runId ? await store.getImplementationArtifact(task.runId) : null;
    const evidence = spec ? await Promise.all(spec.data.scenarios.filter((scenario) => scenario.required).map((scenario) => adapter.readScenarioEvidence(task.specId, scenario.id))) : [];
    const entry = {
      specId: task.specId,
      previousStatus: previousStatusBySpec.get(task.specId) ?? "Architected",
      finalStatus: spec?.data.status ?? "Architected",
      taskStatus: task.status,
      runId: task.runId,
      runStatus: run?.status,
      runResult: run?.result,
      provider: run?.provider ?? task.provider,
      model: run?.model ?? task.model,
      traceId: run?.traceId,
      evidenceGenerated: evidence.filter(Boolean).length,
      passedEvidence: evidence.filter((entry) => entry?.passed).length,
      testsPassed: artifact?.testSummary.passed,
      testsFailed: artifact?.testSummary.failed,
      blockedReason: task.blockedReason,
      failureReason: task.failedReason,
      runSummary: run?.summary,
      discoveryFilesRead: run?.discovery?.readFiles,
      discoveryFilesSelected: run?.discovery?.selectedContextFiles ?? artifact?.discovery?.selectedContextFiles,
      discoveryBlockedReason: run?.discovery?.blockedReason,
      discoveryBudgetUsed: run?.discovery?.budgetUsed,
      pullRequestNumber: task.prNumber ?? artifact?.prNumber,
      pullRequestUrl: task.prUrl ?? artifact?.prUrl
    };
    advanced.push(entry);
    if (task.status === "failed" || task.status === "blocked") {
      const reason = entry.failureReason ?? entry.blockedReason ?? entry.runSummary ?? "No diagnostic reason recorded";
      console.error(`[spec-execution] ${task.specId} ${task.status}: ${reason}`);
    }
  }

  const manifest: ExecutionManifest = {
    version: "v1",
    generatedAt: new Date().toISOString(),
    repository: owner && repo ? `${owner}/${repo}` : undefined,
    branch: executionOptions.baseBranch,
    commitSha: options.commitSha,
    queued: queued.map((task) => ({
      specId: task.specId,
      taskId: task.taskId,
      branchName: task.targetBranch,
      status: task.status,
      created: true
    })),
    advanced
  };

  if (options.reportRootDir) {
    const reportPath = join(options.reportRootDir, "reports/spec-execution/latest.json");
    await mkdir(join(options.reportRootDir, "reports/spec-execution"), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  return { manifest };
}
