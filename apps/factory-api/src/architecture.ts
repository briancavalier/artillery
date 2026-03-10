import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ArchitectureArtifact,
  ArchitectureRun,
  ArchitectureTask,
  CloudEventEnvelope,
  FeatureSpec
} from "@darkfactory/contracts";
import {
  runPipelineStep,
  type ArchitectureProvider,
  type FactoryAdapter,
  type FactoryStorePort
} from "@darkfactory/core";
import { CodexArchitectureProvider, GitHubAutomationApi } from "@darkfactory/implementation-provider-codex";

const execFileAsync = promisify(execFile);

export interface SpecArchitectureOptions {
  actor?: string;
  source?: string;
  deployId?: string;
  repoFullName: string;
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  reportRootDir?: string;
  skipRemoteMergeGate?: boolean;
}

export async function enqueueApprovedSpecsForArchitecture(
  store: FactoryStorePort,
  adapter: FactoryAdapter,
  options: SpecArchitectureOptions
): Promise<ArchitectureTask[]> {
  const specs = await adapter.listSpecs();
  const queued: ArchitectureTask[] = [];
  for (const record of specs) {
    if (record.data.status !== "Approved" || record.data.decision !== "accept") {
      continue;
    }

    const existing = await store.findArchitectureTaskBySpecId(record.data.specId);
    if (existing && ["queued", "running", "merged"].includes(existing.status)) {
      continue;
    }

    const scope = await adapter.getArchitectureScope?.(record.data.specId) ?? {
      artifactRoot: `architecture/${record.data.specId}`,
      allowedPaths: [`architecture/${record.data.specId}/**`],
      maxFilesRead: 32,
      blockedPaths: ["apps/**", "packages/**", ".github/workflows/**", "policy/**"]
    };
    const context = await adapter.buildArchitectureContext?.(record.data.specId);
    const contextBundleRef = await writeArchitectureContextBundle(options.reportRootDir ?? process.cwd(), record.data, context);
    const task = await store.enqueueArchitectureTask({
      specId: record.data.specId,
      source: record.data.source,
      owner: record.data.owner,
      repo: options.repoFullName,
      baseBranch: options.baseBranch,
      baseSha: options.baseSha,
      targetBranch: `codex/architect-${record.data.specId.toLowerCase()}`,
      artifactRoot: context?.artifactRoot ?? scope.artifactRoot,
      contextBundleRef,
      priority: 100,
      limits: {
        maxDurationMs: Number(process.env.ARCHITECTURE_MAX_DURATION_MS ?? 900000),
        maxCostUsd: Number(process.env.ARCHITECTURE_MAX_COST_USD ?? 5),
        maxFilesRead: scope.maxFilesRead ?? context?.discoveryBudget.maxFiles ?? 32
      },
      policy: {
        allowAutoMerge: process.env.ARCHITECTURE_ALLOW_AUTOMERGE !== "0",
        allowNetwork: process.env.ARCHITECTURE_ALLOW_NETWORK !== "0",
        blockedPaths: context?.blockedPaths ?? scope.blockedPaths
      }
    });
    queued.push(task);
    await emit(adapter, options, "architecture_task_queued", task.specId, task.specId, {
      taskId: task.taskId,
      branch: task.targetBranch,
      artifactRoot: task.artifactRoot
    });
  }
  return queued;
}

export async function processArchitectureQueue(
  store: FactoryStorePort,
  adapter: FactoryAdapter,
  provider: ArchitectureProvider,
  options: SpecArchitectureOptions
): Promise<ArchitectureTask[]> {
  const processed: ArchitectureTask[] = [];

  while (true) {
    const leased = await store.leaseArchitectureTask();
    if (!leased) {
      break;
    }

    const task = leased;
    await emit(adapter, options, "architecture_investigation_started", task.specId, task.specId, {
      taskId: task.taskId,
      contextBundleRef: task.contextBundleRef,
      artifactRoot: task.artifactRoot
    });

    try {
      const run = await provider.startTask(task);
      task.runId = run.runId;
      task.provider = run.provider;
      task.model = run.model;
      await store.writeArchitectureRun(run);
      await emitProviderDiagnostics(adapter, options, task, run);

      const artifact = await provider.collectArtifacts(run.runId);
      if (artifact) {
        await store.writeArchitectureArtifact(artifact);
      }

      if (run.status === "blocked" || run.result === "blocked") {
        task.status = "blocked";
        task.blockedReason = run.summary ?? "architecture blocked";
        task.updatedAt = new Date().toISOString();
        await store.writeArchitectureTask(task);
        await emit(adapter, options, "architecture_task_blocked", task.specId, task.specId, {
          taskId: task.taskId,
          runId: run.runId,
          blockedReason: task.blockedReason
        });
        processed.push(task);
        continue;
      }

      if (run.status === "failed" || run.result === "failed" || !artifact) {
        task.status = "failed";
        task.failedReason = run.summary ?? "architecture provider failed";
        task.updatedAt = new Date().toISOString();
        await store.writeArchitectureTask(task);
        await emit(adapter, options, "architecture_task_failed", task.specId, task.specId, {
          taskId: task.taskId,
          runId: run.runId,
          failedReason: task.failedReason
        });
        processed.push(task);
        continue;
      }

      const validation = await validateArchitectureArtifact(adapter, task, artifact);
      if (!validation.ok) {
        task.status = "blocked";
        task.blockedReason = validation.reason;
        task.updatedAt = new Date().toISOString();
        await store.writeArchitectureTask(task);
        await emit(adapter, options, "architecture_task_blocked", task.specId, task.specId, {
          taskId: task.taskId,
          runId: run.runId,
          prNumber: artifact.prNumber,
          blockedReason: validation.reason
        });
        processed.push(task);
        continue;
      }

      task.prNumber = artifact.prNumber;
      task.prUrl = artifact.prUrl;
      task.branch = artifact.branch;

      if (!options.skipRemoteMergeGate && !process.env.ARCHITECTURE_TEST_MODE && options.owner && options.repo) {
        const github = buildGitHubApi();
        const pull = await github.getPullRequest(options.owner, options.repo, artifact.prNumber);
        if (pull.draft) {
          await github.markReadyForReview(options.owner, options.repo, artifact.prNumber);
        }
        await github.dispatchWorkflow(options.owner, options.repo, "ci.yml", artifact.branch);
        await waitForRemoteChecks(options.owner, options.repo, artifact.commitSha, task.limits.maxDurationMs);
        const refreshed = await github.getPullRequest(options.owner, options.repo, artifact.prNumber);
        if (refreshed.mergeable === false || !["clean", "has_hooks", "unstable", "unknown"].includes(refreshed.mergeableState)) {
          throw new Error(`Architecture branch not mergeable: ${refreshed.mergeableState}`);
        }
        if (task.policy.allowAutoMerge) {
          await github.mergePullRequest(options.owner, options.repo, artifact.prNumber, `Architect ${task.specId}`);
        }
        await execGit(process.cwd(), ["pull", "--ff-only", "origin", options.baseBranch]);
      }

      await runPipelineStep(adapter, {
        step: "architect",
        specId: task.specId,
        actor: options.actor,
        source: options.source,
        deployId: options.deployId
      });

      task.status = "merged";
      task.updatedAt = new Date().toISOString();
      await store.writeArchitectureArtifact(artifact);
      await store.writeArchitectureTask(task);
      await emit(adapter, options, "architecture_artifacts_published", task.specId, task.specId, {
        taskId: task.taskId,
        runId: run.runId,
        prNumber: artifact.prNumber,
        artifactRoot: task.artifactRoot
      });
      await emit(adapter, options, "architecture_task_merged", task.specId, task.specId, {
        taskId: task.taskId,
        runId: run.runId,
        prNumber: artifact.prNumber,
        branch: artifact.branch
      });
      processed.push(task);
    } catch (error) {
      task.status = "failed";
      task.failedReason = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date().toISOString();
      await store.writeArchitectureTask(task);
      await emit(adapter, options, "architecture_task_failed", task.specId, task.specId, {
        taskId: task.taskId,
        runId: task.runId ?? "",
        failedReason: task.failedReason
      });
      processed.push(task);
    }
  }

  return processed;
}

export function createArchitectureProvider(owner: string, repo: string): ArchitectureProvider {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for architecture worker");
  }
  return new CodexArchitectureProvider({
    token,
    owner,
    repo,
    repoRoot: process.cwd(),
    github: buildGitHubApi(token)
  });
}

async function writeArchitectureContextBundle(
  rootDir: string,
  spec: FeatureSpec,
  context: Awaited<ReturnType<NonNullable<FactoryAdapter["buildArchitectureContext"]>>> | undefined
): Promise<string> {
  const path = join(rootDir, "reports", "architecture-context", `${spec.specId}.md`);
  await mkdir(dirname(path), { recursive: true });
  const metadata = {
    version: "v1",
    spec: {
      specId: spec.specId,
      title: spec.title,
      intent: spec.intent,
      riskNotes: spec.riskNotes,
      scenarios: spec.scenarios,
      verification: spec.verification
    },
    context: context
      ? {
          relevantFiles: context.relevantFiles,
          readPaths: context.readPaths,
          seedFiles: context.seedFiles,
          discoveryGoals: context.discoveryGoals,
          reviewNotes: context.reviewNotes,
          artifactRoot: context.artifactRoot,
          blockedPaths: context.blockedPaths
        }
      : null
  };
  const body = [
    `# Accepted Spec ${spec.specId}`,
    "",
    `Title: ${spec.title}`,
    `Intent: ${spec.intent}`,
    `Risk notes: ${spec.riskNotes}`,
    "",
    "## Required Scenarios",
    ...spec.scenarios.map((scenario) => `- ${scenario.id}: ${scenario.description} (required=${scenario.required})`),
    "",
    "## Architecture Metadata",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```"
  ].join("\n");
  await writeFile(path, `${body}\n`, "utf8");
  return path;
}

async function validateArchitectureArtifact(
  adapter: FactoryAdapter,
  task: ArchitectureTask,
  artifact: ArchitectureArtifact
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const requiredFiles = [
    `${task.artifactRoot}/README.md`,
    `${task.artifactRoot}/integration-points.json`,
    `${task.artifactRoot}/invariants.json`,
    `${task.artifactRoot}/scenario-trace.json`
  ];
  for (const file of artifact.filesChanged) {
    if (!requiredFiles.includes(file)) {
      return { ok: false, reason: `Architecture PR touched disallowed path: ${file}` };
    }
    if (matchesAny(file, task.policy.blockedPaths)) {
      return { ok: false, reason: `Architecture PR touched blocked path: ${file}` };
    }
  }
  const record = await adapter.readSpecById(task.specId);
  if (!record) {
    return { ok: false, reason: `Spec not found during architecture validation: ${task.specId}` };
  }
  const spec = record.data;
  const requiredScenarios = spec.scenarios.filter((scenario) => scenario.required).map((scenario) => scenario.id);
  const covered = new Set(artifact.payload.scenarioTrace.map((entry) => entry.scenarioId));
  const missing = requiredScenarios.filter((scenarioId) => !covered.has(scenarioId));
  if (missing.length > 0) {
    return { ok: false, reason: `Scenario trace missing required scenarios: ${missing.join(", ")}` };
  }
  return { ok: true };
}

async function emitProviderDiagnostics(
  adapter: FactoryAdapter,
  options: SpecArchitectureOptions,
  task: ArchitectureTask,
  run: ArchitectureRun
): Promise<void> {
  const requestDiagnostics = run.metadata?.requestDiagnostics as { attempts?: Array<Record<string, unknown>> } | undefined;
  if (!requestDiagnostics?.attempts?.length) {
    return;
  }
  const attempts = requestDiagnostics.attempts;
  for (const attempt of attempts.slice(0, -1)) {
    await emit(adapter, options, "provider_request_retry", task.specId, task.specId, {
      taskId: task.taskId,
      runId: run.runId,
      provider: run.provider,
      model: run.model,
      attempt
    });
  }
  await emit(adapter, options, run.status === "failed" ? "provider_request_failed" : "provider_request_succeeded", task.specId, task.specId, {
    taskId: task.taskId,
    runId: run.runId,
    provider: run.provider,
    model: run.model,
    diagnostics: requestDiagnostics
  });
}

async function emit(
  adapter: FactoryAdapter,
  options: SpecArchitectureOptions,
  action: string,
  specId: string,
  scenarioId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const event: CloudEventEnvelope<Record<string, unknown>> = {
    specversion: "1.0",
    id: randomUUID(),
    source: options.source ?? "darkfactory.architecture",
    type: "pipeline_event",
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: {
      action,
      actor: options.actor ?? "architect_worker",
      specId,
      scenarioId,
      deployId: options.deployId ?? `architecture-${Date.now()}`,
      matchId: "MATCH-UNBOUND",
      metadata
    }
  };
  await adapter.appendEvent(event);
}

function buildGitHubApi(token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ""): GitHubAutomationApi {
  return new GitHubAutomationApi(token);
}

async function waitForRemoteChecks(owner: string, repo: string, sha: string, maxDurationMs: number): Promise<void> {
  const api = buildGitHubApi();
  const started = Date.now();
  while (Date.now() - started < maxDurationMs) {
    const checks = await api.listCheckRuns(owner, repo, sha);
    if (checks.length > 0 && checks.every((check) => check.status === "completed")) {
      const failed = checks.filter((check) => !["success", "neutral", "skipped"].includes(check.conclusion ?? ""));
      if (failed.length > 0) {
        throw new Error(`Remote checks failed: ${failed.map((check) => `${check.name}:${check.conclusion}`).join(", ")}`);
      }
      return;
    }
    await sleep(5000);
  }
  throw new Error("Timed out waiting for architecture branch checks");
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "**") {
      return true;
    }
    if (pattern.endsWith("/**")) {
      return path.startsWith(pattern.slice(0, -3));
    }
    return path === pattern;
  });
}

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("git", args, { cwd, env: process.env });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
