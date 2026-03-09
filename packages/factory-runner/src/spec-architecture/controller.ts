import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createArtilleryAdapter } from "@darkfactory/project-adapter-artillery";
import { createFactoryStore, type FactoryStore } from "../../../../apps/factory-api/src/storage.js";
import {
  createArchitectureProvider,
  enqueueApprovedSpecsForArchitecture,
  processArchitectureQueue,
  type SpecArchitectureOptions
} from "../../../../apps/factory-api/src/architecture.js";
import type { ArchitectureProvider, FactoryAdapter } from "@darkfactory/core";
import type { ArchitectureManifest } from "./types.js";

export interface RunSpecArchitectureOptions {
  adapter?: FactoryAdapter;
  store?: FactoryStore;
  provider?: ArchitectureProvider;
  owner?: string;
  repo?: string;
  baseBranch?: string;
  commitSha?: string;
  actor?: string;
  source?: string;
  deployId?: string;
  reportRootDir?: string;
}

export async function runSpecArchitecture(options: RunSpecArchitectureOptions): Promise<{ manifest: ArchitectureManifest }> {
  const owner = options.owner ?? "";
  const repo = options.repo ?? "";
  const adapter = options.adapter ?? createArtilleryAdapter();
  const store = options.store ?? await createFactoryStore();
  const architectureOptions: SpecArchitectureOptions = {
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
      .filter((spec) => spec.data.status === "Approved" && spec.data.decision === "accept")
      .map((spec) => [spec.data.specId, spec.data.status] as const)
  );

  const queued = await enqueueApprovedSpecsForArchitecture(store, adapter, architectureOptions);
  const provider = options.provider ?? (owner && repo ? createArchitectureProvider(owner, repo) : undefined);
  const processed = provider ? await processArchitectureQueue(store, adapter, provider, architectureOptions) : [];

  const advanced = [];
  for (const task of processed) {
    const spec = await adapter.readSpecById(task.specId);
    const run = task.runId ? await store.getArchitectureRun(task.runId) : null;
    const artifact = task.runId ? await store.getArchitectureArtifact(task.runId) : null;
    advanced.push({
      specId: task.specId,
      previousStatus: previousStatusBySpec.get(task.specId) ?? "Approved",
      finalStatus: spec?.data.status ?? "Approved",
      taskStatus: task.status,
      runId: task.runId,
      runStatus: run?.status,
      runResult: run?.result,
      provider: run?.provider ?? task.provider,
      model: run?.model ?? task.model,
      traceId: run?.traceId,
      blockedReason: task.blockedReason,
      failureReason: task.failedReason,
      runSummary: run?.summary,
      pullRequestNumber: task.prNumber ?? artifact?.prNumber,
      pullRequestUrl: task.prUrl ?? artifact?.prUrl
    });
  }

  const manifest: ArchitectureManifest = {
    version: "v1",
    generatedAt: new Date().toISOString(),
    repository: owner && repo ? `${owner}/${repo}` : undefined,
    branch: architectureOptions.baseBranch,
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
    const reportPath = join(options.reportRootDir, "reports/spec-architecture/latest.json");
    await mkdir(join(options.reportRootDir, "reports/spec-architecture"), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  return { manifest };
}
