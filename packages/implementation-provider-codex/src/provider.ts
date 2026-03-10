import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  FeatureSpec,
  ImplementationPlanArtifact,
  ImplementationPlanSlice,
  ImplementationPlanningRun,
  ImplementationArtifact,
  ImplementationDiscoveryBudget,
  ImplementationDiscoveryTrace,
  ImplementationRun,
  ImplementationTask,
  ScenarioSpec
} from "@darkfactory/contracts";
import type { ImplementationContext, ImplementationProvider } from "@darkfactory/core";
import { GitHubAutomationApi } from "./github.js";
import { OpenAiRequestError, type OpenAiRequestDiagnostics, requestOpenAiText } from "./openai.js";

const execFileAsync = promisify(execFile);

interface CodexProviderOptions {
  token: string;
  owner: string;
  repo: string;
  repoRoot: string;
  github: GitHubAutomationApi;
}

interface StoredRun {
  planRun?: ImplementationPlanningRun;
  run?: ImplementationRun;
  planArtifact: ImplementationPlanArtifact | null;
  artifact: ImplementationArtifact | null;
}

interface ParsedCodexResponse {
  responseId?: string;
  rawText: string;
  summary: string;
  patch: string;
  diagnostics: OpenAiRequestDiagnostics;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

interface ParsedPlanResponse {
  responseId?: string;
  rawText: string;
  plan: ImplementationPlanArtifact;
  diagnostics: OpenAiRequestDiagnostics;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

interface ParsedContextBundle {
  spec: Pick<FeatureSpec, "specId" | "title" | "intent" | "riskNotes" | "verification"> & {
    scenarios: ScenarioSpec[];
  };
  context: Pick<
    ImplementationContext,
    | "relevantFiles"
    | "readPaths"
    | "seedFiles"
    | "discoveryGoals"
    | "discoveryBudget"
    | "allowedPaths"
    | "blockedPaths"
    | "recommendedCommands"
    | "evidenceCapabilities"
    | "reviewNotes"
    | "maxFilesChanged"
  > | null;
}

interface AttemptDiagnostic {
  attempt: number;
  responseId?: string;
  repair: boolean;
  repairKind?: "format" | "apply";
  validationError?: string;
  rawOutputPreview: string;
}

interface PatchCheckResult {
  kind: "ok" | "format" | "apply";
  message: string;
}

interface BlockedResponse {
  blocked: boolean;
  reason?: string;
}

interface FileCandidate {
  path: string;
  score: number;
  reasons: string[];
}

interface DiscoveryOutcome {
  trace: ImplementationDiscoveryTrace;
  promptContext: string;
}

export class CodexImplementationProvider implements ImplementationProvider {
  private readonly runs = new Map<string, StoredRun>();

  constructor(private readonly options: CodexProviderOptions) {}

  async planTask(task: ImplementationTask): Promise<ImplementationPlanningRun> {
    const runId = randomUUID();
    const branch = task.targetBranch;
    const worktreePath = join(tmpdir(), `darkfactory-plan-${task.specId.toLowerCase()}-${Date.now()}`);
    let run: ImplementationPlanningRun = {
      runId,
      taskId: task.taskId,
      provider: "openai-codex",
      model: process.env.OPENAI_MODEL ?? "gpt-5-codex",
      status: "running",
      startedAt: new Date().toISOString(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0
      }
    };
    this.runs.set(runId, { planRun: run, run: undefined, planArtifact: null, artifact: null });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      run = {
        ...run,
        status: "blocked",
        finishedAt: new Date().toISOString(),
        result: "blocked",
        summary: "OPENAI_API_KEY is not configured",
        metadata: {
          branch,
          phase: "planning",
          reason: "missing_openai_api_key"
        }
      };
      this.runs.set(runId, { planRun: run, run: undefined, planArtifact: null, artifact: null });
      return run;
    }

    try {
      await execGit(this.options.repoRoot, ["worktree", "add", "-B", branch, worktreePath, task.baseSha]);
      await execGit(worktreePath, ["checkout", branch]);

      const contextText = await readContext(task.contextBundleRef);
      const discovery = await discoverImplementationContext(worktreePath, task, contextText);
      run = { ...run, discovery: discovery.trace };
      this.runs.set(runId, { planRun: run, run: undefined, planArtifact: null, artifact: null });

      if (discovery.trace.blockedReason && discovery.trace.selectedContextFiles.length === 0) {
        run = {
          ...run,
          status: "blocked",
          finishedAt: new Date().toISOString(),
          result: "blocked",
          summary: discovery.trace.blockedReason,
          metadata: {
            ...(run.metadata ?? {}),
            branch,
            phase: "planning_discovery",
            reason: discovery.trace.blockedCategory ?? "discovery_blocked"
          }
        };
        this.runs.set(runId, { planRun: run, run: undefined, planArtifact: null, artifact: null });
        return run;
      }

      const parsed = await requestPlanResponse(apiKey, task, branch, contextText, discovery.promptContext);
      const plan = normalizePlanArtifact(parsed.plan, task, discovery.trace);
      run = {
        ...run,
        status: plan.blockedReason ? "blocked" : "completed",
        finishedAt: new Date().toISOString(),
        result: plan.blockedReason ? "blocked" : "planned",
        traceId: parsed.responseId,
        summary: plan.blockedReason ?? plan.summary,
        usage: parsed.usage,
        discovery: discovery.trace,
        metadata: {
          ...(run.metadata ?? {}),
          branch,
          phase: "planning",
          requestDiagnostics: parsed.diagnostics
        }
      };
      this.runs.set(runId, { planRun: run, run: undefined, planArtifact: plan, artifact: null });
      return run;
    } catch (error) {
      run = {
        ...run,
        status: error instanceof OpenAiRequestError ? "failed" : "blocked",
        finishedAt: new Date().toISOString(),
        result: error instanceof OpenAiRequestError ? "failed" : "blocked",
        summary: error instanceof Error ? error.message : String(error),
        metadata: {
          ...(run.metadata ?? {}),
          branch,
          phase: "planning",
          failureClass: error instanceof OpenAiRequestError ? error.failureClass : undefined,
          requestDiagnostics: error instanceof OpenAiRequestError ? error.diagnostics : undefined,
          statusCode: error instanceof OpenAiRequestError ? error.statusCode : undefined,
          timedOut: error instanceof OpenAiRequestError ? error.timedOut : undefined
        }
      };
      this.runs.set(runId, { planRun: run, run: undefined, planArtifact: null, artifact: null });
      return run;
    } finally {
      await execGit(this.options.repoRoot, ["checkout", task.baseBranch]).catch(() => undefined);
      await execGit(this.options.repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async implementSlice(task: ImplementationTask, plan: ImplementationPlanArtifact, sliceId: string): Promise<ImplementationRun> {
    const slice = plan.slices.find((entry) => entry.sliceId === sliceId);
    if (!slice) {
      return {
        runId: randomUUID(),
        taskId: task.taskId,
        provider: "openai-codex",
        model: process.env.OPENAI_MODEL ?? "gpt-5-codex",
        status: "failed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        result: "failed",
        summary: `Plan slice not found: ${sliceId}`,
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
      };
    }

    const runId = randomUUID();
    const branch = task.targetBranch;
    const worktreePath = join(tmpdir(), `darkfactory-codex-${task.specId.toLowerCase()}-${Date.now()}`);
    let run: ImplementationRun = {
      runId,
      taskId: task.taskId,
      provider: "openai-codex",
      model: process.env.OPENAI_MODEL ?? "gpt-5-codex",
      status: "running",
      startedAt: new Date().toISOString(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0
      }
    };
    this.runs.set(runId, { planRun: undefined, run, planArtifact: plan, artifact: null });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      run = {
        ...run,
        status: "blocked",
        finishedAt: new Date().toISOString(),
        result: "blocked",
        summary: "OPENAI_API_KEY is not configured",
        metadata: {
          branch,
          phase: "implementation",
          reason: "missing_openai_api_key"
        }
      };
      this.runs.set(runId, { planRun: undefined, run, planArtifact: plan, artifact: null });
      return run;
    }

    try {
      await this.options.github.createOrResetBranch(this.options.owner, this.options.repo, branch, task.baseSha);
      await execGit(this.options.repoRoot, ["worktree", "add", "-B", branch, worktreePath, task.baseSha]);
      await execGit(worktreePath, ["checkout", branch]);

      const contextText = await readContext(task.contextBundleRef);
      const discovery = await discoverImplementationContext(worktreePath, task, contextText, slice.targetFiles, 12);
      run = { ...run, discovery: discovery.trace };
      this.runs.set(runId, { planRun: undefined, run, planArtifact: plan, artifact: null });

      if (discovery.trace.blockedReason && discovery.trace.selectedContextFiles.length === 0) {
        run = {
          ...run,
          status: "blocked",
          finishedAt: new Date().toISOString(),
          result: "blocked",
          summary: discovery.trace.blockedReason,
          metadata: {
            ...(run.metadata ?? {}),
            branch,
            phase: "implementation_discovery",
            reason: discovery.trace.blockedCategory ?? "discovery_blocked"
          }
        };
        this.runs.set(runId, { planRun: undefined, run, planArtifact: plan, artifact: null });
        return run;
      }

      await mkdir(join(worktreePath, "reports", "implementation"), { recursive: true });
      const attempts: AttemptDiagnostic[] = [];
      const summaryPath = join(worktreePath, "reports", "implementation", `${task.specId}.md`);
      let parsed: ParsedCodexResponse | null = null;
      let patchCheck: PatchCheckResult = { kind: "format", message: "" };

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const lastAttempt = attempts.at(-1);
        const repairKind = attempt === 1 ? undefined : (patchCheck.kind === "apply" ? "apply" : "format");
        const prompt = attempt === 1
          ? renderSlicePrompt(task, slice, plan, contextText, discovery.promptContext)
          : repairKind === "apply"
            ? renderApplyRepairPrompt(
                task,
                contextText,
                discovery.promptContext,
                lastAttempt?.rawOutputPreview ?? "",
                patchCheck.message,
                await buildFileSnapshots(worktreePath, extractPatchedPaths(parsed?.patch ?? ""))
              )
            : renderRepairPrompt(task, contextText, discovery.promptContext, lastAttempt?.rawOutputPreview ?? "", patchCheck.message);

        parsed = await requestCodexResponse(apiKey, task, branch, prompt, "implement");
        const rawOutputPath = join(worktreePath, "reports", "implementation", `${task.specId}.attempt-${attempt}.txt`);
        await writeFile(rawOutputPath, `${parsed.rawText}\n`, "utf8");

        const blocked = classifyBlockedResponse(parsed.summary, parsed.patch);
        if (blocked.blocked) {
          run = {
            ...run,
            status: "blocked",
            finishedAt: new Date().toISOString(),
            result: "blocked",
            traceId: parsed.responseId,
            summary: blocked.reason ?? parsed.summary,
            usage: parsed.usage,
            discovery: discovery.trace,
            metadata: {
              ...(run.metadata ?? {}),
              branch,
              phase: "implementation",
              reason: "blocked_by_model",
              requestDiagnostics: parsed.diagnostics,
              attempts
            }
          };
          this.runs.set(runId, { planRun: undefined, run, planArtifact: plan, artifact: null });
          await writeFile(summaryPath, `${parsed.summary}\n`, "utf8");
          return run;
        }

        patchCheck = checkPatchText(parsed.patch);
        if (patchCheck.kind === "ok") {
          const patchPath = join(worktreePath, ".darkfactory.patch");
          await writeFile(patchPath, `${parsed.patch}\n`, "utf8");
          patchCheck = await validatePatchWithGit(worktreePath, patchPath);
        }

        attempts.push({
          attempt,
          responseId: parsed.responseId,
          repair: attempt > 1,
          repairKind,
          validationError: patchCheck.kind === "ok" ? undefined : patchCheck.message,
          rawOutputPreview: truncate(parsed.rawText, 2000)
        });

        if (patchCheck.kind === "ok") {
          break;
        }
      }

      if (!parsed) {
        throw new Error("Codex did not return a response.");
      }

      await writeFile(summaryPath, `${parsed.summary}\n`, "utf8");
      if (patchCheck.kind !== "ok") {
        run = {
          ...run,
          status: "failed",
          finishedAt: new Date().toISOString(),
          result: "failed",
          traceId: parsed.responseId,
          summary: patchCheck.message,
          usage: parsed.usage,
          discovery: discovery.trace,
          metadata: {
            ...(run.metadata ?? {}),
            branch,
            phase: "implementation",
            failureStage: "slice_failed",
            requestDiagnostics: parsed.diagnostics,
            attempts
          }
        };
        this.runs.set(runId, { planRun: undefined, run, planArtifact: plan, artifact: null });
        return run;
      }

      const patchPath = join(worktreePath, ".darkfactory.patch");
      await writeFile(patchPath, `${parsed.patch}\n`, "utf8");
      await execFileAsync("git", ["apply", "--reject", "--whitespace=nowarn", patchPath], { cwd: worktreePath, env: process.env });
      await cleanupScratchFiles(worktreePath);
      const changedFiles = await collectChangedFiles(worktreePath);
      const artifact = await publishBranchAndPullRequest({
        github: this.options.github,
        owner: this.options.owner,
        repo: this.options.repo,
        worktreePath,
        task,
        summaryText: parsed.summary,
        changedFiles,
        runId,
        commitLabel: `feat(factory): implement ${task.specId} ${slice.sliceId}`
      });
      artifact.sliceId = slice.sliceId;

      run = {
        ...run,
        status: "completed",
        finishedAt: new Date().toISOString(),
        result: "pr_opened",
        traceId: parsed.responseId,
        summary: parsed.summary,
        usage: parsed.usage,
        discovery: discovery.trace,
        metadata: {
          ...(run.metadata ?? {}),
          branch,
          phase: "implementation",
          sliceId: slice.sliceId,
          requestDiagnostics: parsed.diagnostics,
          attempts
        }
      };
      this.runs.set(runId, {
        planRun: undefined,
        run,
        planArtifact: plan,
        artifact: {
          ...artifact,
          discovery: discovery.trace,
          metadata: {
            ...(artifact.metadata ?? {}),
            discovery: discovery.trace,
            sliceId: slice.sliceId
          }
        }
      });
      return run;
    } catch (error) {
      run = {
        ...run,
        status: "failed",
        finishedAt: new Date().toISOString(),
        result: "failed",
        summary: error instanceof Error ? error.message : String(error),
        metadata: {
          ...(run.metadata ?? {}),
          branch,
          phase: "implementation",
          failureStage: "slice_failed",
          failureClass: error instanceof OpenAiRequestError ? error.failureClass : undefined,
          requestDiagnostics: error instanceof OpenAiRequestError ? error.diagnostics : undefined,
          statusCode: error instanceof OpenAiRequestError ? error.statusCode : undefined,
          timedOut: error instanceof OpenAiRequestError ? error.timedOut : undefined
        }
      };
      this.runs.set(runId, { planRun: undefined, run, planArtifact: plan, artifact: null });
      return run;
    } finally {
      await execGit(this.options.repoRoot, ["checkout", task.baseBranch]).catch(() => undefined);
      await execGit(this.options.repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async getPlanningRun(runId: string): Promise<ImplementationPlanningRun | null> {
    return this.runs.get(runId)?.planRun ?? null;
  }

  async collectPlanArtifact(runId: string): Promise<ImplementationPlanArtifact | null> {
    return this.runs.get(runId)?.planArtifact ?? null;
  }

  async getRun(runId: string): Promise<ImplementationRun | null> {
    return this.runs.get(runId)?.run ?? null;
  }

  async cancelRun(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) {
      return;
    }
    if (entry.run) {
      entry.run = {
        ...entry.run,
        status: "canceled",
        finishedAt: new Date().toISOString(),
        result: entry.run.result ?? "blocked"
      };
    }
    if (entry.planRun) {
      entry.planRun = {
        ...entry.planRun,
        status: "canceled",
        finishedAt: new Date().toISOString(),
        result: entry.planRun.result ?? "blocked"
      };
    }
    this.runs.set(runId, entry);
  }

  async collectArtifacts(runId: string): Promise<ImplementationArtifact | null> {
    return this.runs.get(runId)?.artifact ?? null;
  }
}

async function publishBranchAndPullRequest(params: {
  github: GitHubAutomationApi;
  owner: string;
  repo: string;
  worktreePath: string;
  task: ImplementationTask;
  summaryText: string;
  changedFiles: string[];
  runId: string;
  commitLabel?: string;
}): Promise<ImplementationArtifact> {
  await execGit(params.worktreePath, ["config", "user.name", "github-actions[bot]"]);
  await execGit(params.worktreePath, ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  await execGit(params.worktreePath, ["add", "."]);
  await execGit(params.worktreePath, ["commit", "-m", params.commitLabel ?? `feat(factory): implement ${params.task.specId}`]);
  await execGit(params.worktreePath, ["push", "-u", "origin", params.task.targetBranch]);

  const existing = await params.github.findPullRequestByHead(params.owner, params.repo, `${params.owner}:${params.task.targetBranch}`);
  const pull = existing ?? await params.github.createPullRequest({
    owner: params.owner,
    repo: params.repo,
    head: params.task.targetBranch,
    base: params.task.baseBranch,
    title: `Implement ${params.task.specId}`,
    body: params.summaryText,
    draft: true
  });

  const commitSha = (await execGit(params.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  return {
    runId: params.runId,
    taskId: params.task.taskId,
    prNumber: pull.number,
    prUrl: pull.htmlUrl,
    branch: params.task.targetBranch,
    commitSha,
    filesChanged: params.changedFiles,
    testSummary: {
      passed: 0,
      failed: 0,
      command: "provider-managed"
    },
    evidenceRefs: [],
    summaryMd: params.summaryText,
    metadata: {}
  };
}

async function readContext(contextBundleRef: string): Promise<string> {
  try {
    return await readFile(contextBundleRef, "utf8");
  } catch {
    return `Context bundle not found: ${contextBundleRef}`;
  }
}

async function collectChangedFiles(worktreePath: string): Promise<string[]> {
  const result = await execGit(worktreePath, ["status", "--short"]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[A-Z? ]+/, "").trim())
    .filter(Boolean);
}

async function cleanupScratchFiles(worktreePath: string): Promise<void> {
  const scratchPaths = [
    join(worktreePath, ".darkfactory.patch"),
    join(worktreePath, "reports", "implementation")
  ];
  for (const path of scratchPaths) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function discoverImplementationContext(
  worktreePath: string,
  task: ImplementationTask,
  contextText: string,
  mandatoryFiles: string[] = [],
  supplementalLimit = Number.MAX_SAFE_INTEGER
): Promise<DiscoveryOutcome> {
  const parsedContext = parseContextBundleMetadata(contextText);
  const readPaths = parsedContext?.context?.readPaths?.length ? parsedContext.context.readPaths : ["**"];
  const seedFiles = uniquePaths([
    ...mandatoryFiles,
    ...(parsedContext?.context?.seedFiles ?? []),
    ...(parsedContext?.context?.relevantFiles ?? [])
  ]);
  const discoveryGoals = parsedContext?.context?.discoveryGoals ?? [];
  const discoveryBudget = parsedContext?.context?.discoveryBudget ?? { maxFiles: 40, maxBytes: 200_000 };
  const repoFiles = await listRepoFiles(worktreePath, readPaths);
  const searchedFiles = [...repoFiles];
  const keywords = extractDiscoveryKeywords(parsedContext);
  const contentMatches = await searchFilesByKeyword(worktreePath, keywords);
  const candidates = scoreDiscoveryCandidates(repoFiles, seedFiles, contentMatches, keywords);
  const selection = await selectContextFiles(worktreePath, candidates, discoveryBudget, uniquePaths(mandatoryFiles), supplementalLimit);

  if (selection.selectedFiles.length === 0) {
    const blockedReason = `Blocked: Discovery could not identify plausible integration points for ${task.specId} within the configured read budget.`;
    return {
      trace: {
        searchedFiles,
        readFiles: [],
        selectedContextFiles: [],
        selectionReasons: {},
        blockedCategory: "discovery_no_candidates",
        blockedReason,
        budgetUsed: {
          files: 0,
          bytes: 0
        }
      },
      promptContext: [
        "## Discovery Context",
        blockedReason
      ].join("\n")
    };
  }

  return {
    trace: {
      searchedFiles,
      readFiles: selection.readFiles,
      selectedContextFiles: selection.selectedFiles,
      selectionReasons: selection.selectionReasons,
      budgetUsed: selection.budgetUsed
    },
    promptContext: renderDiscoveredContext(selection.snapshots, discoveryGoals)
  };
}

function renderPlanningPrompt(task: ImplementationTask, contextText: string, discoveredContext: string): string {
  return [
    `Plan implementation for accepted spec ${task.specId}.`,
    `Allowed paths: ${task.allowedPaths.join(", ")}.`,
    `Blocked paths: ${task.policy.blockedPaths.join(", ")}.`,
    `Required scenarios: ${task.verificationTargets.join(", ")}.`,
    "Return JSON only with this shape:",
    `{"summary":"","targetFiles":[],"testFiles":[],"evidenceTargets":[],"risks":[],"blockedReason":null,"slices":[{"sliceId":"","title":"","goal":"","targetFiles":[],"expectedTests":[],"expectedEvidence":[],"writeScope":[],"dependsOnSliceIds":[]}]} `,
    "Rules:",
    "- No markdown or prose outside JSON.",
    "- At least one slice, at most four slices.",
    "- Slice 1 must be narrowly scoped and touch no more than eight files.",
    "- Each required scenario must be covered by one or more slices.",
    "- If blocked, set blockedReason and return an empty slices array.",
    "",
    "Context bundle:",
    contextText,
    "",
    discoveredContext
  ].join("\n");
}

function renderSlicePrompt(
  task: ImplementationTask,
  slice: ImplementationPlanSlice,
  plan: ImplementationPlanArtifact,
  contextText: string,
  discoveredContext: string
): string {
  return [
    `Implement slice ${slice.sliceId} for accepted spec ${task.specId}.`,
    `Slice title: ${slice.title}`,
    `Slice goal: ${slice.goal}`,
    `Slice target files: ${slice.targetFiles.join(", ")}`,
    `Slice write scope: ${slice.writeScope.join(", ")}`,
    `Expected tests: ${slice.expectedTests.join(", ")}`,
    `Expected evidence: ${slice.expectedEvidence.join(", ")}`,
    "Return only two sections:",
    "SUMMARY:",
    "<short explanation>",
    "PATCH:",
    "```diff",
    "diff --git a/path/to/file b/path/to/file",
    "--- a/path/to/file",
    "+++ b/path/to/file",
    "@@",
    "<unified diff patch>",
    "```",
    "The PATCH section must be a valid unified diff that git apply can consume directly.",
    "Do not return prose, markdown lists, or code fences outside the required SUMMARY/PATCH structure.",
    "If the task is blocked, start SUMMARY with 'Blocked:' and leave the PATCH section empty.",
    "",
    "Approved plan artifact:",
    JSON.stringify({
      planId: plan.planId,
      summary: plan.summary,
      slices: plan.slices.map((entry) => ({
        sliceId: entry.sliceId,
        title: entry.title,
        targetFiles: entry.targetFiles,
        dependsOnSliceIds: entry.dependsOnSliceIds
      }))
    }, null, 2),
    "",
    "Context bundle:",
    contextText,
    "",
    discoveredContext
  ].join("\n");
}

function renderRepairPrompt(
  task: ImplementationTask,
  contextText: string,
  discoveredContext: string,
  priorOutput: string,
  validationError: string
): string {
  return [
    `Your previous response for ${task.specId} was not a valid unified diff.`,
    `Validation error: ${validationError}`,
    "Repair the response and return only the required two sections.",
    "Do not describe the diff. Output only:",
    "SUMMARY:",
    "<short explanation>",
    "PATCH:",
    "```diff",
    "diff --git a/path/to/file b/path/to/file",
    "--- a/path/to/file",
    "+++ b/path/to/file",
    "@@",
    "<valid unified diff patch>",
    "```",
    "",
    "Previous invalid output:",
    priorOutput,
    "",
    "Original context bundle:",
    contextText,
    "",
    discoveredContext,
    "",
    `Allowed paths: ${task.allowedPaths.join(", ")}.`,
    `Blocked paths: ${task.policy.blockedPaths.join(", ")}.`,
    "If you are blocked, start SUMMARY with 'Blocked:' and leave PATCH empty.",
    "If you are editing an existing file, do not use 'new file mode', '/dev/null', or '@@ -0,0' headers."
  ].join("\n");
}

function renderApplyRepairPrompt(
  task: ImplementationTask,
  contextText: string,
  discoveredContext: string,
  priorOutput: string,
  applyError: string,
  fileSnapshots: string
): string {
  return [
    `Your previous unified diff for ${task.specId} did not apply to the current repository state.`,
    `git apply error: ${applyError}`,
    "Return a corrected diff against the current file contents.",
    "Do not explain the diff outside the required sections.",
    "Return only:",
    "SUMMARY:",
    "<short explanation>",
    "PATCH:",
    "```diff",
    "diff --git a/path/to/file b/path/to/file",
    "--- a/path/to/file",
    "+++ b/path/to/file",
    "@@",
    "<valid unified diff patch against the current file contents>",
    "```",
    "",
    "Previous invalid output:",
    priorOutput,
    "",
    "Current file snapshots for the touched files:",
    fileSnapshots || "(No file snapshots available)",
    "",
    "Original context bundle:",
    contextText,
    "",
    discoveredContext,
    "",
    `Allowed paths: ${task.allowedPaths.join(", ")}.`,
    `Blocked paths: ${task.policy.blockedPaths.join(", ")}.`,
    "Do not modify unrelated files such as README.md unless the spec explicitly requires it.",
    "If you are editing an existing file, do not use 'new file mode', '/dev/null', or '@@ -0,0' headers."
  ].join("\n");
}

function parseContextBundleMetadata(contextText: string): ParsedContextBundle | null {
  const match = contextText.match(/## Discovery Metadata\s+```json\n([\s\S]*?)\n```/i);
  if (!match?.[1]) {
    return null;
  }
  try {
    return JSON.parse(match[1]) as ParsedContextBundle;
  } catch {
    return null;
  }
}

async function listRepoFiles(worktreePath: string, readPaths: string[]): Promise<string[]> {
  const tracked = await execGit(worktreePath, ["ls-files"]);
  return tracked.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => !isIgnoredDiscoveryPath(path))
    .filter((path) => matchesAny(path, readPaths));
}

function isIgnoredDiscoveryPath(path: string): boolean {
  return [
    ".git/",
    "node_modules/",
    "dist/",
    "coverage/",
    "var/",
    "reports/"
  ].some((prefix) => path.startsWith(prefix));
}

function extractDiscoveryKeywords(parsedContext: ParsedContextBundle | null): string[] {
  const text = [
    parsedContext?.spec.specId,
    parsedContext?.spec.title,
    parsedContext?.spec.intent,
    parsedContext?.spec.riskNotes,
    ...(parsedContext?.spec.scenarios.map((scenario) => scenario.description) ?? []),
    ...(parsedContext?.context?.discoveryGoals ?? []),
    ...(parsedContext?.context?.reviewNotes ?? [])
  ]
    .filter(Boolean)
    .join(" ");

  const stopWords = new Set([
    "about", "after", "agent", "alongside", "be", "break", "capabilities", "current", "deterministic",
    "does", "evidence", "existing", "factory", "feature", "files", "find", "for", "from", "game",
    "goals", "ground", "have", "implementation", "inside", "integration", "keep", "leave", "main",
    "must", "not", "notes", "only", "paths", "placement", "project", "required", "review", "runs",
    "safe", "scenarios", "should", "spec", "stable", "tests", "that", "the", "their", "them", "this",
    "turn", "update", "verification", "worker"
  ]);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !stopWords.has(token));

  return [...new Set(tokens)].slice(0, 16);
}

async function searchFilesByKeyword(worktreePath: string, keywords: string[]): Promise<Set<string>> {
  if (keywords.length === 0) {
    return new Set();
  }

  const args = ["grep", "-il"];
  for (const keyword of keywords.slice(0, 8)) {
    args.push("-e", keyword);
  }
  args.push("--");

  try {
    const result = await execGit(worktreePath, args);
    return new Set(
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((path) => !isIgnoredDiscoveryPath(path))
    );
  } catch {
    return new Set();
  }
}

function scoreDiscoveryCandidates(
  repoFiles: string[],
  seedFiles: string[],
  contentMatches: Set<string>,
  keywords: string[]
): FileCandidate[] {
  const seedSet = new Set(seedFiles);
  const seedDirectories = new Set(seedFiles.map((path) => dirname(path)).filter(Boolean));

  return repoFiles.map((path) => {
    let score = 0;
    const reasons: string[] = [];
    const normalized = path.toLowerCase();

    if (seedSet.has(path)) {
      score += 100;
      reasons.push("seed file");
    }
    if ([...seedDirectories].some((directory) => directory !== "." && path.startsWith(`${directory}/`))) {
      score += 40;
      reasons.push("adjacent to seed file");
    }
    if (contentMatches.has(path)) {
      score += 35;
      reasons.push("matches discovery keywords in file contents");
    }
    const matchingKeywords = keywords.filter((keyword) => normalized.includes(keyword));
    if (matchingKeywords.length > 0) {
      score += Math.min(30, matchingKeywords.length * 10);
      reasons.push(`path matches keywords: ${matchingKeywords.slice(0, 3).join(", ")}`);
    }
    if (/(simulation|terrain|determin|projectile|render|match|spawn|evidence|test|scenario)/.test(normalized)) {
      score += 15;
      reasons.push("path suggests relevant integration surface");
    }
    if ([".ts", ".tsx", ".json", ".md"].includes(extname(path))) {
      score += 5;
    }

    return { path, score, reasons };
  }).filter((candidate) => candidate.score > 10)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

async function selectContextFiles(
  worktreePath: string,
  candidates: FileCandidate[],
  discoveryBudget: ImplementationDiscoveryBudget,
  mandatoryFiles: string[],
  supplementalLimit: number
): Promise<{
  readFiles: string[];
  selectedFiles: string[];
  selectionReasons: Record<string, string>;
  budgetUsed: { files: number; bytes: number };
  snapshots: string[];
}> {
  const selectionReasons: Record<string, string> = {};
  const readFiles: string[] = [];
  const selectedFiles: string[] = [];
  const snapshots: string[] = [];
  let bytes = 0;
  let supplementalFiles = 0;

  for (const candidate of candidates) {
    if (selectedFiles.length >= discoveryBudget.maxFiles) {
      break;
    }
    const required = mandatoryFiles.includes(candidate.path);
    if (!required && supplementalFiles >= supplementalLimit) {
      continue;
    }

    try {
      const contents = await readFile(join(worktreePath, candidate.path), "utf8");
      const contentBytes = Buffer.byteLength(contents);
      readFiles.push(candidate.path);
      if (bytes + contentBytes > discoveryBudget.maxBytes && selectedFiles.length > 0) {
        continue;
      }

      selectedFiles.push(candidate.path);
      selectionReasons[candidate.path] = candidate.reasons.join("; ") || "selected by discovery";
      bytes += contentBytes;
      if (!required) {
        supplementalFiles += 1;
      }
      snapshots.push([
        `FILE: ${candidate.path}`,
        `REASON: ${selectionReasons[candidate.path]}`,
        "```",
        truncate(contents, 8000),
        "```"
      ].join("\n"));
    } catch {
      continue;
    }
  }

  return {
    readFiles,
    selectedFiles,
    selectionReasons,
    budgetUsed: {
      files: selectedFiles.length,
      bytes
    },
    snapshots
  };
}

function renderDiscoveredContext(snapshots: string[], discoveryGoals: string[]): string {
  return [
    "## Discovery Goals",
    ...(discoveryGoals.length > 0 ? discoveryGoals.map((goal) => `- ${goal}`) : ["- No explicit discovery goals supplied."]),
    "",
    "## Selected Repository Context",
    ...(snapshots.length > 0 ? snapshots : ["No repository context selected."])
  ].join("\n");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

async function requestPlanResponse(
  apiKey: string,
  task: ImplementationTask,
  branch: string,
  contextText: string,
  discoveredContext: string
): Promise<ParsedPlanResponse> {
  const response = await requestOpenAiText({
    apiKey,
    prompt: renderPlanningPrompt(task, contextText, discoveredContext),
    systemPrompt: PLANNING_SYSTEM_PROMPT,
    metadata: {
      specId: task.specId,
      taskId: task.taskId,
      branch,
      stage: "implementation-plan"
    },
    timeoutMs: Number(process.env.OPENAI_PLANNING_TIMEOUT_MS ?? 90_000),
    maxAttempts: Number(process.env.OPENAI_PLANNING_MAX_ATTEMPTS ?? 3),
    backoffMs: Number(process.env.OPENAI_PLANNING_BACKOFF_MS ?? 1_000)
  });
  return {
    responseId: response.responseId,
    rawText: response.rawText,
    plan: parsePlanArtifact(response.rawText, task),
    diagnostics: response.diagnostics,
    usage: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      estimatedCostUsd: response.estimatedCostUsd
    }
  };
}

async function requestCodexResponse(
  apiKey: string,
  task: ImplementationTask,
  branch: string,
  prompt: string,
  phase: "implement" | "repair"
): Promise<ParsedCodexResponse> {
  const response = await requestOpenAiText({
    apiKey,
    prompt,
    systemPrompt: IMPLEMENTATION_SYSTEM_PROMPT,
    metadata: {
      specId: task.specId,
      taskId: task.taskId,
      branch,
      stage: phase
    },
    timeoutMs: Number(process.env.OPENAI_IMPLEMENT_TIMEOUT_MS ?? 120_000),
    maxAttempts: Number(process.env.OPENAI_IMPLEMENT_MAX_ATTEMPTS ?? 4),
    backoffMs: Number(process.env.OPENAI_IMPLEMENT_BACKOFF_MS ?? 1_500)
  });
  const rawText = response.rawText;
  return {
    responseId: response.responseId,
    rawText,
    summary: extractSummary(rawText),
    patch: extractPatch(rawText),
    usage: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      estimatedCostUsd: response.estimatedCostUsd
    },
    diagnostics: response.diagnostics
  };
}

function parsePlanArtifact(rawText: string, task: ImplementationTask): ImplementationPlanArtifact {
  const parsed = JSON.parse(rawText) as Partial<ImplementationPlanArtifact>;
  return {
    runId: "",
    taskId: task.taskId,
    planId: typeof parsed.planId === "string" && parsed.planId ? parsed.planId : randomUUID(),
    specId: task.specId,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    targetFiles: Array.isArray(parsed.targetFiles) ? parsed.targetFiles.map(String) : [],
    testFiles: Array.isArray(parsed.testFiles) ? parsed.testFiles.map(String) : [],
    evidenceTargets: Array.isArray(parsed.evidenceTargets) ? parsed.evidenceTargets.map(String) : [],
    slices: Array.isArray(parsed.slices) ? parsed.slices.map(normalizePlanSlice) : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
    blockedReason: typeof parsed.blockedReason === "string" && parsed.blockedReason ? parsed.blockedReason : undefined,
    selectedContextFiles: [],
    metadata: {}
  };
}

function normalizePlanSlice(slice: unknown): ImplementationPlanSlice {
  const parsed = (slice ?? {}) as Record<string, unknown>;
  return {
    sliceId: typeof parsed.sliceId === "string" && parsed.sliceId ? parsed.sliceId : `slice-${randomUUID().slice(0, 8)}`,
    title: typeof parsed.title === "string" ? parsed.title : "",
    goal: typeof parsed.goal === "string" ? parsed.goal : "",
    targetFiles: Array.isArray(parsed.targetFiles) ? parsed.targetFiles.map(String) : [],
    expectedTests: Array.isArray(parsed.expectedTests) ? parsed.expectedTests.map(String) : [],
    expectedEvidence: Array.isArray(parsed.expectedEvidence) ? parsed.expectedEvidence.map(String) : [],
    writeScope: Array.isArray(parsed.writeScope) ? parsed.writeScope.map(String) : [],
    dependsOnSliceIds: Array.isArray(parsed.dependsOnSliceIds) ? parsed.dependsOnSliceIds.map(String) : []
  };
}

function normalizePlanArtifact(
  artifact: ImplementationPlanArtifact,
  task: ImplementationTask,
  discovery: ImplementationDiscoveryTrace
): ImplementationPlanArtifact {
  return {
    ...artifact,
    taskId: task.taskId,
    specId: task.specId,
    targetFiles: uniquePaths(artifact.targetFiles),
    testFiles: uniquePaths(artifact.testFiles),
    evidenceTargets: uniquePaths(artifact.evidenceTargets),
    slices: artifact.slices.map((slice) => ({
      ...slice,
      targetFiles: uniquePaths(slice.targetFiles),
      expectedTests: uniquePaths(slice.expectedTests),
      expectedEvidence: uniquePaths(slice.expectedEvidence),
      writeScope: uniquePaths(slice.writeScope),
      dependsOnSliceIds: uniquePaths(slice.dependsOnSliceIds)
    })),
    selectedContextFiles: discovery.selectedContextFiles,
    metadata: {
      ...(artifact.metadata ?? {}),
      updatedAt: new Date().toISOString()
    }
  };
}

function extractSummary(text: string): string {
  const match = text.match(/SUMMARY:\s*([\s\S]*?)\nPATCH:/i);
  return match?.[1]?.trim() || text.trim();
}

function extractPatch(text: string): string {
  const fenced = text.match(/PATCH:\s*```diff\n([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const direct = text.match(/PATCH:\s*([\s\S]*)$/i);
  return direct?.[1]?.trim() || "";
}

function checkPatchText(patch: string): PatchCheckResult {
  if (!patch.trim()) {
    return { kind: "format", message: "Codex did not return a patch." };
  }
  if (!isLikelyUnifiedDiff(patch)) {
    return { kind: "format", message: "Codex returned PATCH content that is not a valid unified diff." };
  }
  return { kind: "ok", message: "" };
}

function classifyBlockedResponse(summary: string, patch: string): BlockedResponse {
  const normalizedSummary = summary.trim();
  if (!normalizedSummary) {
    return { blocked: false };
  }
  const explicitlyBlocked = /^blocked:/i.test(normalizedSummary);
  if (!explicitlyBlocked) {
    return { blocked: false };
  }
  if (patch.trim()) {
    return { blocked: false };
  }
  return { blocked: true, reason: normalizedSummary };
}

async function validatePatchWithGit(worktreePath: string, patchPath: string): Promise<PatchCheckResult> {
  try {
    await execFileAsync("git", ["apply", "--check", "--verbose", patchPath], { cwd: worktreePath, env: process.env });
    return { kind: "ok", message: "" };
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String((error as { stderr?: string }).stderr ?? "") : "";
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
    return {
      kind: /patch does not apply|patch failed:/i.test(message) ? "apply" : "format",
      message
    };
  }
}

function isLikelyUnifiedDiff(patch: string): boolean {
  const normalized = patch.trim();
  if (!normalized) {
    return false;
  }
  const hasDiffHeader = normalized.includes("diff --git ");
  const hasFileHeaders = normalized.includes("\n--- ") && normalized.includes("\n+++ ");
  const hasHunk = normalized.includes("\n@@");
  return hasDiffHeader && hasFileHeaders && hasHunk;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function extractPatchedPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const candidate = match[2] ?? match[1];
    if (candidate && candidate !== "/dev/null") {
      paths.add(candidate);
    }
  }
  return [...paths];
}

async function buildFileSnapshots(worktreePath: string, paths: string[]): Promise<string> {
  const snapshots: string[] = [];
  for (const relativePath of paths.slice(0, 6)) {
    try {
      const contents = await readFile(join(worktreePath, relativePath), "utf8");
      snapshots.push([
        `FILE: ${relativePath}`,
        "```",
        truncate(contents, 6000),
        "```"
      ].join("\n"));
    } catch {
      snapshots.push([
        `FILE: ${relativePath}`,
        "(File does not exist in current checkout)"
      ].join("\n"));
    }
  }
  return snapshots.join("\n\n");
}

function matchesAny(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
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

const PLANNING_SYSTEM_PROMPT = [
  "You are the dark factory implementation planning worker.",
  "Return JSON only.",
  "Break the work into 1-4 implementation slices.",
  "Make slice 1 small and safe.",
  "If the architecture artifacts are insufficient or contradictory, return blockedReason and no slices."
].join(" ");

const IMPLEMENTATION_SYSTEM_PROMPT = [
  "You are the dark factory implementation worker.",
  "Implement only the requested slice.",
  "Stay inside the allowed paths and the slice write scope.",
  "Produce a small, reviewable unified diff.",
  "Prefer code and tests over prose.",
  "If the slice is ambiguous or unsafe, stop and explain the blocker."
].join(" ");

export const codexProviderInternals = {
  extractSummary,
  extractPatch,
  parsePlanArtifact,
  checkPatchText,
  classifyBlockedResponse,
  isLikelyUnifiedDiff,
  parseContextBundleMetadata,
  listRepoFiles,
  extractDiscoveryKeywords,
  scoreDiscoveryCandidates,
  selectContextFiles,
  renderDiscoveredContext,
  renderRepairPrompt,
  renderApplyRepairPrompt,
  extractPatchedPaths,
  matchesAny
};
