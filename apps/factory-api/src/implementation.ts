import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CloudEventEnvelope, FeatureSpec, ImplementationArtifact, ImplementationRun, ImplementationTask } from "@darkfactory/contracts";
import { runPipelineStep, type FactoryAdapter, type FactoryStorePort, type ImplementationProvider } from "@darkfactory/core";
import { createArtilleryAdapter } from "@darkfactory/project-adapter-artillery";
import { CodexImplementationProvider, GitHubAutomationApi } from "@darkfactory/implementation-provider-codex";
import type { FactoryStore } from "./storage.js";

const execFileAsync = promisify(execFile);

export interface SpecExecutionOptions {
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

export async function enqueueAcceptedSpecs(
  store: FactoryStorePort,
  adapter: FactoryAdapter,
  options: SpecExecutionOptions
): Promise<ImplementationTask[]> {
  const specs = await adapter.listSpecs();
  const queued: ImplementationTask[] = [];
  for (const record of specs) {
    if (record.data.status !== "Approved" || record.data.decision !== "accept") {
      continue;
    }

    const existing = await store.findImplementationTaskBySpecId(record.data.specId);
    if (existing && ["queued", "running", "merge_ready", "merged"].includes(existing.status)) {
      continue;
    }

    const scope = await adapter.getImplementationScope?.(record.data.specId) ?? {
      allowedPaths: ["apps/artillery-game/**", "tests/**", `evidence/${record.data.specId}/**`],
      blockedPaths: ["apps/factory-api/**", "packages/factory-core/**", "packages/factory-runner/**"],
      maxFilesChanged: 24
    };
    const context = await adapter.buildImplementationContext?.(record.data.specId);
    const contextBundleRef = await writeContextBundle(options.reportRootDir ?? process.cwd(), record.data, context);

    const task = await store.enqueueImplementationTask({
      specId: record.data.specId,
      source: record.data.source,
      owner: record.data.owner,
      repo: options.repoFullName,
      baseBranch: options.baseBranch,
      baseSha: options.baseSha,
      targetBranch: `codex/implement-${record.data.specId.toLowerCase()}`,
      allowedPaths: context?.allowedPaths ?? scope.allowedPaths,
      verificationTargets: record.data.scenarios.filter((scenario) => scenario.required).map((scenario) => scenario.id),
      contextBundleRef,
      priority: 100,
      limits: {
        maxTurns: Number(process.env.IMPLEMENTATION_MAX_TURNS ?? 6),
        maxDurationMs: Number(process.env.IMPLEMENTATION_MAX_DURATION_MS ?? 900000),
        maxCostUsd: Number(process.env.IMPLEMENTATION_MAX_COST_USD ?? 5),
        maxFilesChanged: context?.maxFilesChanged ?? scope.maxFilesChanged ?? 24
      },
      policy: {
        allowAutoMerge: process.env.IMPLEMENTATION_ALLOW_AUTOMERGE !== "0",
        allowShell: true,
        allowNetwork: false,
        blockedPaths: context?.blockedPaths ?? scope.blockedPaths
      }
    });
    queued.push(task);
    await emit(adapter, options, "implementation_task_queued", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
      taskId: task.taskId,
      branch: task.targetBranch,
      attempt: task.attempt
    });
  }
  return queued;
}

export async function processImplementationQueue(
  store: FactoryStore,
  adapter: FactoryAdapter,
  provider: ImplementationProvider,
  options: SpecExecutionOptions
): Promise<ImplementationTask[]> {
  const processed: ImplementationTask[] = [];

  while (true) {
    const leased = await store.leaseImplementationTask();
    if (!leased) {
      break;
    }

    let task = leased;
    await emit(adapter, options, "implementation_task_started", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
      taskId: task.taskId,
      branch: task.targetBranch,
      attempt: task.attempt
    });
    await emit(adapter, options, "implementation_context_discovery_started", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
      taskId: task.taskId,
      branch: task.targetBranch,
      attempt: task.attempt,
      contextBundleRef: task.contextBundleRef
    });

    try {
      const run = await provider.startTask(task);
      task.runId = run.runId;
      task.provider = run.provider;
      task.model = run.model;
      await store.writeImplementationRun(run);

      const artifact = await provider.collectArtifacts(run.runId);
      if (artifact) {
        artifact.runId = run.runId;
        await store.writeImplementationArtifact(artifact);
      }

      if (run.discovery) {
        await emit(adapter, options, "implementation_context_discovery_completed", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
          taskId: task.taskId,
          runId: run.runId,
          provider: run.provider,
          model: run.model,
          traceId: run.traceId ?? "",
          searchedFiles: run.discovery.searchedFiles.slice(0, 200),
          readFiles: run.discovery.readFiles,
          selectedContextFiles: run.discovery.selectedContextFiles,
          selectionReasons: run.discovery.selectionReasons,
          blockedCategory: run.discovery.blockedCategory ?? "",
          blockedReason: run.discovery.blockedReason ?? "",
          discoveryBudgetUsed: run.discovery.budgetUsed
        });
      }

      if (run.status === "blocked" || run.result === "blocked") {
        task.status = "blocked";
        task.blockedReason = run.summary ?? "provider blocked";
        task.updatedAt = new Date().toISOString();
        await store.writeImplementationTask(task);
        await emit(adapter, options, "implementation_task_blocked", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
          taskId: task.taskId,
          runId: run.runId,
          provider: run.provider,
          model: run.model,
          traceId: run.traceId ?? "",
          attempt: task.attempt,
          estimatedCostUsd: run.usage.estimatedCostUsd,
          inputTokens: run.usage.inputTokens,
          outputTokens: run.usage.outputTokens,
          selectedContextFiles: run.discovery?.selectedContextFiles ?? [],
          discoveryBudgetUsed: run.discovery?.budgetUsed,
          blockedReason: task.blockedReason ?? ""
        });
        if (run.discovery?.blockedReason) {
          await emit(adapter, options, "implementation_context_discovery_blocked", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
            taskId: task.taskId,
            runId: run.runId,
            provider: run.provider,
            model: run.model,
            traceId: run.traceId ?? "",
            blockedCategory: run.discovery.blockedCategory ?? "",
            blockedReason: run.discovery.blockedReason,
            selectedContextFiles: run.discovery.selectedContextFiles,
            discoveryBudgetUsed: run.discovery.budgetUsed
          });
        }
        processed.push(task);
        continue;
      }

      if (run.status === "failed" || run.result === "failed" || !artifact) {
        task.status = "failed";
        task.failedReason = !artifact && run.summary ? `${run.summary} (artifact missing)` : (run.summary ?? "provider failed");
        task.updatedAt = new Date().toISOString();
        await store.writeImplementationTask(task);
        await emit(adapter, options, "implementation_task_failed", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
          taskId: task.taskId,
          runId: run.runId,
          provider: run.provider,
          model: run.model,
          traceId: run.traceId ?? "",
          attempt: task.attempt,
          estimatedCostUsd: run.usage.estimatedCostUsd,
          inputTokens: run.usage.inputTokens,
          outputTokens: run.usage.outputTokens,
          failedReason: task.failedReason ?? ""
        });
        processed.push(task);
        continue;
      }

      await emit(adapter, options, "implementation_pr_opened", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
        taskId: task.taskId,
        runId: run.runId,
        provider: run.provider,
        model: run.model,
        traceId: run.traceId ?? "",
        prNumber: artifact.prNumber,
        branch: artifact.branch,
        filesChanged: artifact.filesChanged.length,
        estimatedCostUsd: run.usage.estimatedCostUsd,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens
      });

      const policyResult = validateArtifact(task, artifact);
      if (!policyResult.ok) {
        task.status = "blocked";
        task.blockedReason = policyResult.reason;
        task.updatedAt = new Date().toISOString();
        await store.writeImplementationRun({
          ...run,
          metadata: {
            ...(run.metadata ?? {}),
            orchestrationState: "blocked",
            orchestrationReason: policyResult.reason
          }
        });
        await store.writeImplementationTask(task);
        await emit(adapter, options, "implementation_task_blocked", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
          taskId: task.taskId,
          runId: run.runId,
          prNumber: artifact.prNumber,
          branch: artifact.branch,
          blockedReason: policyResult.reason,
          filesChanged: artifact.filesChanged.length
        });
        processed.push(task);
        continue;
      }

      task.prNumber = artifact.prNumber;
      task.prUrl = artifact.prUrl;
      task.branch = artifact.branch;

      if (options.skipRemoteMergeGate || process.env.IMPLEMENTATION_TEST_MODE === "1" || !options.owner || !options.repo) {
        const evidence = await adapter.generateScenarioEvidence?.(task.specId, {
          actor: options.actor,
          source: options.source,
          deployId: options.deployId
        }) ?? [];
        artifact.evidenceRefs = evidence.map((entry) => entry.artifact ?? "").filter(Boolean);
      } else {
        let evidenceBlocked = false;
        await withCheckedOutBranch(options.baseBranch, artifact.branch, async () => {
          const checks = await runLocalChecks();
          artifact.testSummary = {
            passed: checks.passed ? 3 : 0,
            failed: checks.passed ? 0 : 1,
            command: checks.command
        };

        if (!checks.passed) {
          throw new Error(checks.errorMessage ?? "Local checks failed");
        }

        const evidence = await adapter.generateScenarioEvidence?.(task.specId, {
          actor: options.actor,
          source: options.source,
          deployId: options.deployId
        }) ?? [];
        artifact.evidenceRefs = evidence.map((entry) => entry.artifact ?? "").filter(Boolean);

        const gitStatus = await execGit(process.cwd(), ["status", "--short"]);
        if (gitStatus.stdout.trim()) {
          await execGit(process.cwd(), ["config", "user.name", "github-actions[bot]"]);
          await execGit(process.cwd(), ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
          await execGit(process.cwd(), ["add", "."]);
          await execGit(process.cwd(), ["commit", "-m", `test(factory): add evidence for ${task.specId}`]).catch(() => undefined);
          await execGit(process.cwd(), ["push", "origin", artifact.branch]);
          const currentSha = (await execGit(process.cwd(), ["rev-parse", "HEAD"])) .stdout.trim();
          artifact.commitSha = currentSha;
        }

        const evidenceGate = await evaluateRequiredEvidence(adapter, task.specId, task.verificationTargets);
        if (!evidenceGate.ok) {
          task.status = "blocked";
          task.blockedReason = `Required scenario evidence missing or failed: ${evidenceGate.missing.join(", ")}`;
          task.updatedAt = new Date().toISOString();
          await store.writeImplementationRun({
            ...run,
            metadata: {
              ...(run.metadata ?? {}),
              orchestrationState: "blocked",
              orchestrationReason: task.blockedReason,
              missingScenarioEvidence: evidenceGate.missing
            }
          });
          await store.writeImplementationArtifact(artifact);
          await store.writeImplementationTask(task);
          await emit(adapter, options, "implementation_task_blocked", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
            taskId: task.taskId,
            runId: run.runId,
            prNumber: artifact.prNumber,
            branch: artifact.branch,
            blockedReason: task.blockedReason,
            filesChanged: artifact.filesChanged.length,
            testsPassed: artifact.testSummary.passed,
            testsFailed: artifact.testSummary.failed
          });
          evidenceBlocked = true;
          return;
        }

        const pull = await buildGitHubApi().getPullRequest(options.owner, options.repo, artifact.prNumber);
        if (pull.draft) {
          await buildGitHubApi().markReadyForReview(options.owner, options.repo, artifact.prNumber);
        }

        await buildGitHubApi().dispatchWorkflow(options.owner, options.repo, "ci.yml", artifact.branch);
        await waitForRemoteChecks(options.owner, options.repo, artifact.commitSha, task.limits.maxDurationMs);
        const refreshed = await buildGitHubApi().getPullRequest(options.owner, options.repo, artifact.prNumber);
        if (refreshed.mergeable === false || !["clean", "has_hooks", "unstable", "unknown"].includes(refreshed.mergeableState)) {
          throw new Error(`Branch protection/mergeability not satisfied: ${refreshed.mergeableState}`);
        }

        if (task.policy.allowAutoMerge) {
          await buildGitHubApi().mergePullRequest(options.owner, options.repo, artifact.prNumber, `Implement ${task.specId}`);
        }
        });

        if (evidenceBlocked) {
          processed.push(task);
          continue;
        }

        await withCheckedOutBranch(artifact.branch, options.baseBranch, async () => {
          await execGit(process.cwd(), ["pull", "--ff-only", "origin", options.baseBranch]);
        });
      }

      const evidenceGate = await evaluateRequiredEvidence(adapter, task.specId, task.verificationTargets);
      if (!evidenceGate.ok) {
        task.status = "blocked";
        task.blockedReason = `Required scenario evidence missing or failed: ${evidenceGate.missing.join(", ")}`;
        task.updatedAt = new Date().toISOString();
        await store.writeImplementationRun({
          ...run,
          metadata: {
            ...(run.metadata ?? {}),
            orchestrationState: "blocked",
            orchestrationReason: task.blockedReason,
            missingScenarioEvidence: evidenceGate.missing
          }
        });
        await store.writeImplementationArtifact(artifact);
        await store.writeImplementationTask(task);
        await emit(adapter, options, "implementation_task_blocked", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
          taskId: task.taskId,
          runId: run.runId,
          prNumber: artifact.prNumber,
          branch: artifact.branch,
          blockedReason: task.blockedReason,
          filesChanged: artifact.filesChanged.length,
          testsPassed: artifact.testSummary.passed,
          testsFailed: artifact.testSummary.failed
        });
        processed.push(task);
        continue;
      }

      await runPipelineStep(adapter, { step: "implement", specId: task.specId, actor: options.actor, source: options.source, deployId: options.deployId });
      await runPipelineStep(adapter, { step: "verify", specId: task.specId, actor: options.actor, source: options.source, deployId: options.deployId });

      task.status = "merged";
      task.updatedAt = new Date().toISOString();
      await store.writeImplementationArtifact(artifact);
      await store.writeImplementationTask(task);
      await emit(adapter, options, "implementation_task_merged", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
        taskId: task.taskId,
        runId: run.runId,
        provider: run.provider,
        model: run.model,
        traceId: run.traceId ?? "",
        prNumber: artifact.prNumber,
        branch: artifact.branch,
        filesChanged: artifact.filesChanged.length,
        testsPassed: artifact.testSummary.passed,
        testsFailed: artifact.testSummary.failed,
        estimatedCostUsd: run.usage.estimatedCostUsd,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens
      });
      processed.push(task);
    } catch (error) {
      task.status = "failed";
      task.failedReason = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date().toISOString();
      if (task.runId) {
        const run = await store.getImplementationRun(task.runId);
        if (run) {
          await store.writeImplementationRun({
            ...run,
            metadata: {
              ...(run.metadata ?? {}),
              orchestrationState: "failed",
              orchestrationReason: task.failedReason
            }
          });
        }
      }
      await store.writeImplementationTask(task);
      await emit(adapter, options, "implementation_task_failed", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
        taskId: task.taskId,
        runId: task.runId ?? "",
        prNumber: task.prNumber ?? 0,
        branch: task.branch ?? task.targetBranch,
        failedReason: task.failedReason,
        attempt: task.attempt
      });
      processed.push(task);
    }
  }

  return processed;
}

export function createCodexProvider(owner: string, repo: string): ImplementationProvider {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for implementation worker");
  }
  return new CodexImplementationProvider({
    token,
    owner,
    repo,
    repoRoot: process.cwd(),
    github: buildGitHubApi(token)
  });
}

function buildGitHubApi(token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ""): GitHubAutomationApi {
  return new GitHubAutomationApi(token);
}

async function writeContextBundle(
  rootDir: string,
  spec: FeatureSpec,
  context: Awaited<ReturnType<NonNullable<FactoryAdapter["buildImplementationContext"]>>> | undefined
): Promise<string> {
  const specId = spec.specId;
  const path = join(rootDir, "reports", "implementation-context", `${specId}.md`);
  await mkdir(dirname(path), { recursive: true });
  const discoveryMetadata = {
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
          discoveryBudget: context.discoveryBudget,
          allowedPaths: context.allowedPaths,
          blockedPaths: context.blockedPaths,
          recommendedCommands: context.recommendedCommands,
          evidenceCapabilities: context.evidenceCapabilities,
          reviewNotes: context.reviewNotes,
          maxFilesChanged: context.maxFilesChanged
        }
      : null
  };
  const specSection = [
    `# Accepted Spec ${specId}`,
    "",
    `Title: ${spec.title}`,
    `Intent: ${spec.intent}`,
    `Risk notes: ${spec.riskNotes}`,
    "",
    "## Required Scenarios",
    ...spec.scenarios.map((scenario) => `- ${scenario.id}: ${scenario.description} (required=${scenario.required})`),
    "",
    "## Verification Map",
    ...spec.verification.map((entry) => `- ${entry.scenarioId}: ${entry.checks.join(", ")}`)
  ];
  const contextSection = context
    ? [
        "",
        "## Project Context",
        `Relevant files: ${context.relevantFiles.join(", ")}`,
        `Read paths: ${context.readPaths.join(", ")}`,
        `Seed files: ${context.seedFiles.join(", ")}`,
        `Discovery goals: ${context.discoveryGoals.join(" | ")}`,
        `Discovery budget: files=${context.discoveryBudget.maxFiles}, bytes=${context.discoveryBudget.maxBytes}`,
        `Allowed paths: ${context.allowedPaths.join(", ")}`,
        `Blocked paths: ${context.blockedPaths.join(", ")}`,
        `Recommended commands: ${context.recommendedCommands.join(", ")}`,
        `Evidence capabilities: ${context.evidenceCapabilities.join(", ")}`,
        `Review notes: ${context.reviewNotes.join(" | ")}`,
        "",
        "## Discovery Metadata",
        "```json",
        JSON.stringify(discoveryMetadata, null, 2),
        "```"
      ]
    : [
        "",
        "## Project Context",
        "No adapter context available.",
        "",
        "## Discovery Metadata",
        "```json",
        JSON.stringify(discoveryMetadata, null, 2),
        "```"
      ];
  const body = [...specSection, ...contextSection].join("\n");
  await writeFile(path, `${body}\n`, "utf8");
  return path;
}

async function emit(
  adapter: FactoryAdapter,
  options: SpecExecutionOptions,
  action: string,
  specId: string,
  scenarioId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const event: CloudEventEnvelope<Record<string, unknown>> = {
    specversion: "1.0",
    id: randomUUID(),
    source: options.source ?? "darkfactory.implementation",
    type: "pipeline_event",
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: {
      action,
      actor: options.actor ?? "implementation_worker",
      specId,
      scenarioId,
      deployId: options.deployId ?? `implementation-${Date.now()}`,
      matchId: "MATCH-UNBOUND",
      metadata
    }
  };
  await adapter.appendEvent(event);
}

function validateArtifact(task: ImplementationTask, artifact: ImplementationArtifact): { ok: true } | { ok: false; reason: string } {
  if (artifact.filesChanged.length > task.limits.maxFilesChanged) {
    return { ok: false, reason: `Changed file count ${artifact.filesChanged.length} exceeds cap ${task.limits.maxFilesChanged}` };
  }

  for (const file of artifact.filesChanged) {
    if (matchesAny(file, task.policy.blockedPaths)) {
      return { ok: false, reason: `Blocked path touched: ${file}` };
    }
    if (!matchesAny(file, task.allowedPaths)) {
      return { ok: false, reason: `File outside allowlist: ${file}` };
    }
  }

  return { ok: true };
}

async function evaluateRequiredEvidence(
  adapter: FactoryAdapter,
  specId: string,
  scenarioIds: string[]
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const missing: string[] = [];
  for (const scenarioId of scenarioIds) {
    const evidence = await adapter.readScenarioEvidence(specId, scenarioId);
    if (!evidence || evidence.passed !== true) {
      missing.push(scenarioId);
    }
  }

  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}

async function runLocalChecks(): Promise<{ passed: boolean; command: string; errorMessage?: string }> {
  const command = "npm test && npm run contract:check && npm run policy:check";
  try {
    await execFileAsync("/bin/bash", ["-lc", buildPortableNodeCommand(command)], {
      cwd: process.cwd(),
      env: process.env,
      timeout: Number(process.env.IMPLEMENTATION_MAX_DURATION_MS ?? 900000)
    });
    return { passed: true, command };
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String((error as { stderr?: string }).stderr ?? "") : "";
    return { passed: false, command, errorMessage: stderr || (error instanceof Error ? error.message : String(error)) };
  }
}

function buildPortableNodeCommand(command: string): string {
  return [
    "export XDG_STATE_HOME=/tmp/fnm-state",
    "if command -v fnm >/dev/null 2>&1; then eval \"$(fnm env --shell bash)\"; fi",
    "if command -v nvm >/dev/null 2>&1; then nvm use >/dev/null; fi",
    command
  ].join("; ");
}

async function waitForRemoteChecks(owner: string, repo: string, sha: string, maxDurationMs: number): Promise<void> {
  const api = buildGitHubApi();
  const started = Date.now();
  while (Date.now() - started < maxDurationMs) {
    const checks = await api.listCheckRuns(owner, repo, sha);
    if (checks.length === 0) {
      await sleep(5000);
      continue;
    }
    if (checks.every((check) => check.status === "completed")) {
      const failed = checks.filter((check) => check.conclusion !== "success" && check.conclusion !== "neutral" && check.conclusion !== "skipped");
      if (failed.length > 0) {
        throw new Error(`Remote checks failed: ${failed.map((check) => `${check.name}:${check.conclusion}`).join(", ")}`);
      }
      return;
    }
    await sleep(5000);
  }
  throw new Error("Timed out waiting for remote checks");
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      return path.startsWith(pattern.slice(0, -3));
    }
    return path === pattern;
  });
}

async function withCheckedOutBranch(fromBranch: string, targetBranch: string, work: () => Promise<void>): Promise<void> {
  const current = (await execGit(process.cwd(), ["rev-parse", "--abbrev-ref", "HEAD"])) .stdout.trim() || fromBranch;
  if (current !== targetBranch) {
    await execGit(process.cwd(), ["checkout", targetBranch]).catch(async () => {
      await execGit(process.cwd(), ["fetch", "origin", targetBranch]);
      await execGit(process.cwd(), ["checkout", targetBranch]);
    });
  }
  try {
    await work();
  } finally {
    if (current !== targetBranch) {
      await execGit(process.cwd(), ["checkout", current]).catch(() => undefined);
    }
  }
}

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("git", args, { cwd, env: process.env });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const implementationInternals = {
  buildPortableNodeCommand
};
