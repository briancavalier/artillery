import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CloudEventEnvelope,
  FeatureSpec,
  ImplementationArtifact,
  ImplementationPlanArtifact,
  ImplementationPlanSlice,
  ImplementationPlanningRun,
  ImplementationRun,
  ImplementationTask
} from "@darkfactory/contracts";
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
    if (record.data.status !== "Architected" || record.data.decision !== "accept") {
      continue;
    }

    const existing = await store.findImplementationTaskBySpecId(record.data.specId);
    if (existing && ["queued", "running", "merge_ready"].includes(existing.status)) {
      continue;
    }

    const scope = await adapter.getImplementationScope?.(record.data.specId) ?? {
      allowedPaths: ["apps/artillery-game/**", "tests/**", `evidence/${record.data.specId}/**`],
      blockedPaths: ["apps/factory-api/**", "packages/factory-core/**", "packages/factory-runner/**"],
      maxFilesChanged: 24
    };
    const context = await adapter.buildImplementationContext?.(record.data.specId);
    const architectureArtifactPresent = context?.relevantFiles.some((path) => path.startsWith(`architecture/${record.data.specId}/`)) ?? false;
    if (!architectureArtifactPresent) {
      await emit(adapter, options, "gate_failed", record.data.specId, record.data.scenarios[0]?.id ?? "SCN-UNBOUND", {
        gate: "architect",
        reason: `Missing architecture artifacts for ${record.data.specId}`
      });
      continue;
    }
    const contextBundleRef = await writeContextBundle(options.reportRootDir ?? process.cwd(), record.data, context);
    const planArtifact = await store.findImplementationPlanArtifactBySpecId(record.data.specId);
    const nextSlice = getNextSlice(planArtifact, existing);
    if (planArtifact && !nextSlice && existing?.status === "merged") {
      continue;
    }

    const task = await store.enqueueImplementationTask({
      specId: record.data.specId,
      source: record.data.source,
      owner: record.data.owner,
      repo: options.repoFullName,
      baseBranch: options.baseBranch,
      baseSha: options.baseSha,
      targetBranch: `codex/implement-${record.data.specId.toLowerCase()}`,
      allowedPaths: nextSlice?.writeScope.length ? nextSlice.writeScope : (context?.allowedPaths ?? scope.allowedPaths),
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
      },
      planId: planArtifact?.planId,
      sliceId: nextSlice?.sliceId,
      sliceIndex: nextSlice?.sliceIndex,
      totalSlices: planArtifact?.slices.length
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
  const processedSpecs = new Set<string>();

  while (true) {
    const leased = await store.leaseImplementationTask();
    if (!leased) {
      break;
    }

    let task = leased;
    if (processedSpecs.has(task.specId)) {
      task.status = "queued";
      task.updatedAt = new Date().toISOString();
      await store.writeImplementationTask(task);
      break;
    }
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
      let planArtifact = task.planId
        ? await store.findImplementationPlanArtifactBySpecId(task.specId)
        : null;

      if (!planArtifact || !task.sliceId) {
        await emit(adapter, options, "implementation_plan_started", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
          taskId: task.taskId,
          branch: task.targetBranch,
          attempt: task.attempt
        });
        const planningRun = await provider.planTask(task);
        await store.writeImplementationPlanningRun(planningRun);
        await emitPlanningDiagnostics(adapter, options, task, planningRun);
        planArtifact = await provider.collectPlanArtifact(planningRun.runId);

        if (!planArtifact && (planningRun.status === "failed" || planningRun.result === "failed")) {
          task.status = "failed";
          task.failedReason = planningRun.summary ?? "planning failed";
          task.updatedAt = new Date().toISOString();
          await store.writeImplementationTask(task);
          await emit(adapter, options, "implementation_plan_rejected", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
            taskId: task.taskId,
            runId: planningRun.runId,
            failedReason: task.failedReason
          });
          processed.push(task);
          processedSpecs.add(task.specId);
          continue;
        }

        if (!planArtifact) {
          task.status = "failed";
          task.failedReason = "Planning completed without a plan artifact";
          task.updatedAt = new Date().toISOString();
          await store.writeImplementationTask(task);
          processed.push(task);
          processedSpecs.add(task.specId);
          continue;
        }

        const planValidation = validatePlanArtifact(task, planArtifact);
        if (!planValidation.ok) {
          task.status = planValidation.kind === "blocked" ? "blocked" : "failed";
          task.blockedReason = planValidation.kind === "blocked" ? planValidation.reason : undefined;
          task.failedReason = planValidation.kind === "failed" ? planValidation.reason : undefined;
          task.updatedAt = new Date().toISOString();
          await store.writeImplementationPlanArtifact(planArtifact);
          await store.writeImplementationTask(task);
          await emit(adapter, options, "implementation_plan_rejected", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
            taskId: task.taskId,
            runId: planningRun.runId,
            reason: planValidation.reason,
            kind: planValidation.kind
          });
          processed.push(task);
          processedSpecs.add(task.specId);
          continue;
        }

        planArtifact.runId = planningRun.runId;
        await store.writeImplementationPlanArtifact(planArtifact);
        await writeImplementationPlanArtifacts(options.reportRootDir ?? process.cwd(), planArtifact);
        const firstSlice = planArtifact.slices[0];
        task.planId = planArtifact.planId;
        task.sliceId = firstSlice.sliceId;
        task.sliceIndex = 0;
        task.totalSlices = planArtifact.slices.length;
        task.allowedPaths = firstSlice.writeScope;
        task.updatedAt = new Date().toISOString();
        await store.writeImplementationTask(task);
        await emit(adapter, options, planArtifact.blockedReason ? "implementation_plan_blocked" : "implementation_plan_completed", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
          taskId: task.taskId,
          runId: planningRun.runId,
          planId: planArtifact.planId,
          sliceCount: planArtifact.slices.length,
          blockedReason: planArtifact.blockedReason ?? "",
          selectedContextFiles: planArtifact.selectedContextFiles
        });

        if (planArtifact.blockedReason) {
          task.status = "blocked";
          task.blockedReason = planArtifact.blockedReason;
          await store.writeImplementationTask(task);
          processed.push(task);
          processedSpecs.add(task.specId);
          continue;
        }
      }

      const slice = planArtifact.slices.find((entry) => entry.sliceId === task.sliceId);
      if (!slice) {
        task.status = "failed";
        task.failedReason = `Plan slice not found: ${task.sliceId ?? "unknown"}`;
        task.updatedAt = new Date().toISOString();
        await store.writeImplementationTask(task);
        processed.push(task);
        processedSpecs.add(task.specId);
        continue;
      }

      await emit(adapter, options, "implementation_slice_started", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
        taskId: task.taskId,
        planId: planArtifact.planId,
        sliceId: slice.sliceId,
        sliceIndex: task.sliceIndex ?? 0
      });

      const run = await provider.implementSlice(task, planArtifact, slice.sliceId);
      task.runId = run.runId;
      task.provider = run.provider;
      task.model = run.model;
      await store.writeImplementationRun(run);
      await emitProviderDiagnostics(adapter, options, task, run);

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
          blockedReason: task.blockedReason ?? "",
          failureStage: "slice_failed"
        });
        processed.push(task);
        processedSpecs.add(task.specId);
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
          failedReason: task.failedReason ?? "",
          failureStage: "slice_failed"
        });
        processed.push(task);
        processedSpecs.add(task.specId);
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
        filesChanged: artifact.filesChanged.length
      });

      const policyResult = validateArtifact(task, artifact);
      if (!policyResult.ok) {
        task.status = "blocked";
        task.blockedReason = policyResult.reason;
        task.updatedAt = new Date().toISOString();
        await store.writeImplementationTask(task);
        processed.push(task);
        continue;
      }

      task.prNumber = artifact.prNumber;
      task.prUrl = artifact.prUrl;
      task.branch = artifact.branch;

      await completeImplementationMerge(adapter, store, options, task, run, artifact, slice, planArtifact);
      processed.push(task);
      processedSpecs.add(task.specId);
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
      processedSpecs.add(task.specId);
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

async function emitProviderDiagnostics(
  adapter: FactoryAdapter,
  options: SpecExecutionOptions,
  task: ImplementationTask,
  run: ImplementationRun
): Promise<void> {
  const requestDiagnostics = run.metadata?.requestDiagnostics as { attempts?: Array<Record<string, unknown>> } | undefined;
  if (!requestDiagnostics?.attempts?.length) {
    return;
  }
  const attempts = requestDiagnostics.attempts;
  for (const attempt of attempts.slice(0, -1)) {
    await emit(adapter, options, "provider_request_retry", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
      taskId: task.taskId,
      runId: run.runId,
      provider: run.provider,
      model: run.model,
      attempt
    });
  }
  await emit(
    adapter,
    options,
    run.status === "failed" ? "provider_request_failed" : "provider_request_succeeded",
    task.specId,
    task.verificationTargets[0] ?? "SCN-UNBOUND",
    {
      taskId: task.taskId,
      runId: run.runId,
      provider: run.provider,
      model: run.model,
      diagnostics: requestDiagnostics
    }
  );
}

async function emitPlanningDiagnostics(
  adapter: FactoryAdapter,
  options: SpecExecutionOptions,
  task: ImplementationTask,
  run: ImplementationPlanningRun
): Promise<void> {
  const requestDiagnostics = run.metadata?.requestDiagnostics as { attempts?: Array<Record<string, unknown>> } | undefined;
  if (!requestDiagnostics?.attempts?.length) {
    return;
  }
  for (const attempt of requestDiagnostics.attempts.slice(0, -1)) {
    await emit(adapter, options, "provider_request_retry", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
      taskId: task.taskId,
      runId: run.runId,
      provider: run.provider,
      model: run.model,
      stage: "plan",
      attempt
    });
  }
  await emit(
    adapter,
    options,
    run.status === "failed" ? "provider_request_failed" : "provider_request_succeeded",
    task.specId,
    task.verificationTargets[0] ?? "SCN-UNBOUND",
    {
      taskId: task.taskId,
      runId: run.runId,
      provider: run.provider,
      model: run.model,
      stage: "plan",
      diagnostics: requestDiagnostics
    }
  );
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

function validatePlanArtifact(
  task: ImplementationTask,
  planArtifact: ImplementationPlanArtifact
): { ok: true } | { ok: false; kind: "blocked" | "failed"; reason: string } {
  if (planArtifact.blockedReason?.trim()) {
    return { ok: false, kind: "blocked", reason: planArtifact.blockedReason.trim() };
  }
  if (!Array.isArray(planArtifact.slices) || planArtifact.slices.length === 0) {
    return { ok: false, kind: "failed", reason: "Implementation plan must contain at least one slice" };
  }
  if (planArtifact.slices.length > 4) {
    return { ok: false, kind: "failed", reason: "Implementation plan exceeds v1 slice cap (4)" };
  }

  const covered = new Set<string>();
  for (const [index, slice] of planArtifact.slices.entries()) {
    if (!slice.sliceId || !slice.title || !slice.goal) {
      return { ok: false, kind: "failed", reason: `Implementation slice ${index + 1} is missing required fields` };
    }
    if (index === 0 && slice.targetFiles.length > 8) {
      return { ok: false, kind: "failed", reason: "First implementation slice is too broad (>8 target files)" };
    }
    for (const targetFile of slice.targetFiles) {
      if (matchesAny(targetFile, task.policy.blockedPaths)) {
        return { ok: false, kind: "failed", reason: `Plan slice targets blocked path: ${targetFile}` };
      }
      if (!matchesAny(targetFile, task.allowedPaths)) {
        return { ok: false, kind: "failed", reason: `Plan slice targets path outside implementation allowlist: ${targetFile}` };
      }
    }
    for (const writePath of slice.writeScope) {
      if (matchesAny(writePath, task.policy.blockedPaths)) {
        return { ok: false, kind: "failed", reason: `Plan slice write scope touches blocked path: ${writePath}` };
      }
      if (!matchesAny(writePath, task.allowedPaths)) {
        return { ok: false, kind: "failed", reason: `Plan slice write scope exceeds allowlist: ${writePath}` };
      }
    }
    for (const scenarioId of slice.expectedEvidence) {
      covered.add(scenarioId);
    }
  }

  const missingScenarios = task.verificationTargets.filter((scenarioId) => !covered.has(scenarioId));
  if (missingScenarios.length > 0) {
    return {
      ok: false,
      kind: "failed",
      reason: `Implementation plan does not cover required scenarios: ${missingScenarios.join(", ")}`
    };
  }

  return { ok: true };
}

function getNextSlice(
  planArtifact: ImplementationPlanArtifact | null,
  existingTask: ImplementationTask | null
): (ImplementationPlanSlice & { sliceIndex: number }) | undefined {
  if (!planArtifact) {
    return undefined;
  }
  if (!existingTask?.planId || existingTask.planId !== planArtifact.planId) {
    const first = planArtifact.slices[0];
    return first ? { ...first, sliceIndex: 0 } : undefined;
  }
  const nextIndex = existingTask.status === "merged"
    ? (existingTask.sliceIndex ?? -1) + 1
    : (existingTask.sliceIndex ?? 0);
  const next = planArtifact.slices[nextIndex];
  return next ? { ...next, sliceIndex: nextIndex } : undefined;
}

async function writeImplementationPlanArtifacts(rootDir: string, planArtifact: ImplementationPlanArtifact): Promise<void> {
  const planPath = join(rootDir, "implementation-plans", planArtifact.specId, "plan.json");
  const summaryPath = join(rootDir, "reports", "implementation-plan", `${planArtifact.specId}.md`);
  await mkdir(dirname(planPath), { recursive: true });
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(planPath, `${JSON.stringify(planArtifact, null, 2)}\n`, "utf8");
  const summaryLines = [
    `# Implementation Plan ${planArtifact.specId}`,
    "",
    planArtifact.summary,
    "",
    "## Slices",
    ...planArtifact.slices.flatMap((slice, index) => [
      `### ${index + 1}. ${slice.title}`,
      `Goal: ${slice.goal}`,
      `Target files: ${slice.targetFiles.join(", ") || "(none)"}`,
      `Expected tests: ${slice.expectedTests.join(", ") || "(none)"}`,
      `Expected evidence: ${slice.expectedEvidence.join(", ") || "(none)"}`,
      `Write scope: ${slice.writeScope.join(", ") || "(none)"}`,
      `Depends on: ${slice.dependsOnSliceIds.join(", ") || "(none)"}`,
      ""
    ]),
    "## Risks",
    ...(planArtifact.risks.length > 0 ? planArtifact.risks.map((risk) => `- ${risk}`) : ["- None recorded"]),
    ""
  ];
  await writeFile(summaryPath, summaryLines.join("\n"), "utf8");
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

async function completeImplementationMerge(
  adapter: FactoryAdapter,
  store: FactoryStorePort,
  options: SpecExecutionOptions,
  task: ImplementationTask,
  run: ImplementationRun,
  artifact: ImplementationArtifact,
  slice: ImplementationPlanSlice,
  planArtifact: ImplementationPlanArtifact
): Promise<void> {
  const localChecks = await runLocalChecks();
  artifact.testSummary = {
    passed: localChecks.passed ? 1 : 0,
    failed: localChecks.passed ? 0 : 1,
    command: localChecks.command
  };
  await store.writeImplementationArtifact(artifact);

  if (!localChecks.passed) {
    task.status = "blocked";
    task.blockedReason = localChecks.errorMessage ?? "Local checks failed";
    task.updatedAt = new Date().toISOString();
    await store.writeImplementationTask(task);
    await emit(adapter, options, "implementation_task_blocked", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
      taskId: task.taskId,
      runId: run.runId,
      blockedReason: task.blockedReason,
      failureStage: "slice_failed"
    });
    return;
  }

  if (!options.skipRemoteMergeGate && !process.env.IMPLEMENTATION_TEST_MODE && options.owner && options.repo) {
    const github = buildGitHubApi();
    const pull = await github.getPullRequest(options.owner, options.repo, artifact.prNumber);
    if (pull.draft) {
      await github.markReadyForReview(options.owner, options.repo, artifact.prNumber);
    }
    await github.dispatchWorkflow(options.owner, options.repo, "ci.yml", artifact.branch);
    await waitForRemoteChecks(options.owner, options.repo, artifact.commitSha, task.limits.maxDurationMs);
    const refreshed = await github.getPullRequest(options.owner, options.repo, artifact.prNumber);
    if (refreshed.mergeable === false || !["clean", "has_hooks", "unstable", "unknown"].includes(refreshed.mergeableState)) {
      throw new Error(`Implementation branch not mergeable: ${refreshed.mergeableState}`);
    }
    if (task.policy.allowAutoMerge) {
      await github.mergePullRequest(options.owner, options.repo, artifact.prNumber, `Implement ${task.specId} (${slice.sliceId})`);
    }
    await execGit(process.cwd(), ["pull", "--ff-only", "origin", options.baseBranch]);
  }

  await emit(adapter, options, "implementation_iteration_completed", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
    taskId: task.taskId,
    runId: run.runId,
    planId: planArtifact.planId,
    sliceId: slice.sliceId,
    prNumber: artifact.prNumber
  });
  await emit(adapter, options, "implementation_slice_completed", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
    taskId: task.taskId,
    runId: run.runId,
    planId: planArtifact.planId,
    sliceId: slice.sliceId,
    sliceIndex: task.sliceIndex ?? 0
  });

  const isFinalSlice = (task.sliceIndex ?? 0) >= planArtifact.slices.length - 1;
  if (!isFinalSlice) {
    const nextSlice = planArtifact.slices[(task.sliceIndex ?? 0) + 1];
    if (!nextSlice) {
      throw new Error(`Missing next slice for ${task.specId}`);
    }
    task.status = "merged";
    task.updatedAt = new Date().toISOString();
    await store.writeImplementationTask(task);
    await store.enqueueImplementationTask({
      specId: task.specId,
      source: task.source,
      owner: task.owner,
      repo: task.repo,
      baseBranch: task.baseBranch,
      baseSha: task.baseSha,
      targetBranch: task.targetBranch,
      allowedPaths: nextSlice.writeScope,
      verificationTargets: task.verificationTargets,
      contextBundleRef: task.contextBundleRef,
      priority: task.priority,
      limits: task.limits,
      policy: task.policy,
      planId: planArtifact.planId,
      sliceId: nextSlice.sliceId,
      sliceIndex: (task.sliceIndex ?? 0) + 1,
      totalSlices: planArtifact.slices.length
    });
    await emit(adapter, options, "implementation_task_merged", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
      taskId: task.taskId,
      runId: run.runId,
      planId: planArtifact.planId,
      sliceId: slice.sliceId,
      prNumber: artifact.prNumber,
      nextSliceId: nextSlice.sliceId
    });
    return;
  }

  if (adapter.generateScenarioEvidence) {
    await adapter.generateScenarioEvidence(task.specId, {
      actor: options.actor,
      source: options.source,
      deployId: options.deployId
    });
  }

  const evidenceGate = await evaluateRequiredEvidence(adapter, task.specId, task.verificationTargets);
  if (!evidenceGate.ok) {
    task.status = "blocked";
    task.blockedReason = `Required scenario evidence missing or failed: ${evidenceGate.missing.join(", ")}`;
    task.updatedAt = new Date().toISOString();
    await store.writeImplementationTask(task);
    await emit(adapter, options, "implementation_task_blocked", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
      taskId: task.taskId,
      runId: run.runId,
      prNumber: artifact.prNumber,
      blockedReason: task.blockedReason
    });
    return;
  }

  await runPipelineStep(adapter, {
    step: "implement",
    specId: task.specId,
    actor: options.actor,
    source: options.source,
    deployId: options.deployId
  });
  await runPipelineStep(adapter, {
    step: "verify",
    specId: task.specId,
    actor: options.actor,
    source: options.source,
    deployId: options.deployId
  });

  task.status = "merged";
  task.updatedAt = new Date().toISOString();
  await store.writeImplementationTask(task);
  await emit(adapter, options, "implementation_task_merged", task.specId, task.verificationTargets[0] ?? "SCN-UNBOUND", {
    taskId: task.taskId,
    runId: run.runId,
    planId: planArtifact.planId,
    sliceId: slice.sliceId,
    prNumber: artifact.prNumber
  });
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
