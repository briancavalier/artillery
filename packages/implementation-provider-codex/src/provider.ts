import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ImplementationArtifact, ImplementationRun, ImplementationTask } from "@darkfactory/contracts";
import type { ImplementationProvider } from "@darkfactory/core";
import { GitHubAutomationApi } from "./github.js";

const execFileAsync = promisify(execFile);

interface CodexProviderOptions {
  token: string;
  owner: string;
  repo: string;
  repoRoot: string;
  github: GitHubAutomationApi;
}

interface StoredRun {
  run: ImplementationRun;
  artifact: ImplementationArtifact | null;
}

interface ParsedCodexResponse {
  responseId?: string;
  rawText: string;
  summary: string;
  patch: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
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

export class CodexImplementationProvider implements ImplementationProvider {
  private readonly runs = new Map<string, StoredRun>();

  constructor(private readonly options: CodexProviderOptions) {}

  async startTask(task: ImplementationTask): Promise<ImplementationRun> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const branch = task.targetBranch;
    const worktreePath = join(tmpdir(), `darkfactory-codex-${task.specId.toLowerCase()}-${Date.now()}`);
    let run: ImplementationRun = {
      runId,
      taskId: task.taskId,
      provider: "openai-codex",
      model: process.env.OPENAI_MODEL ?? "gpt-5-codex",
      status: "running",
      startedAt,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0
      }
    };
    this.runs.set(runId, { run, artifact: null });

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
          phase: "provider_init",
          reason: "missing_openai_api_key"
        }
      };
      this.runs.set(runId, { run, artifact: null });
      return run;
    }

    try {
      await this.options.github.createOrResetBranch(this.options.owner, this.options.repo, branch, task.baseSha);
      await execGit(this.options.repoRoot, ["worktree", "add", "-B", branch, worktreePath, task.baseSha]);
      await execGit(worktreePath, ["checkout", branch]);

      const contextText = await readContext(task.contextBundleRef);
      await mkdir(join(worktreePath, "reports", "implementation"), { recursive: true });
      const attempts: AttemptDiagnostic[] = [];
      const summaryPath = join(worktreePath, "reports", "implementation", `${task.specId}.md`);
      let parsed: ParsedCodexResponse | null = null;
      let patchCheck: PatchCheckResult = { kind: "format", message: "" };

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const lastAttempt = attempts.at(-1);
        const repairKind = attempt === 1 ? undefined : (patchCheck.kind === "apply" ? "apply" : "format");
        const prompt = attempt === 1
          ? renderUserPrompt(task, contextText)
          : repairKind === "apply"
            ? renderApplyRepairPrompt(
                task,
                contextText,
                lastAttempt?.rawOutputPreview ?? "",
                patchCheck.message,
                await buildFileSnapshots(worktreePath, extractPatchedPaths(parsed?.patch ?? ""))
              )
            : renderRepairPrompt(task, contextText, lastAttempt?.rawOutputPreview ?? "", patchCheck.message);

        parsed = await requestCodexResponse(apiKey, task, branch, prompt);
        const rawOutputPath = join(worktreePath, "reports", "implementation", `${task.specId}.attempt-${attempt}.txt`);
        await writeFile(rawOutputPath, `${parsed.rawText}\n`, "utf8");

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
          metadata: {
            branch,
            phase: "provider_response",
            reason: patchCheck.kind === "apply" ? "patch_does_not_apply" : "invalid_patch",
            attempts
          }
        };
        this.runs.set(runId, { run, artifact: null });
        return run;
      }

      const patchPath = join(worktreePath, ".darkfactory.patch");
      await writeFile(patchPath, `${parsed.patch}\n`, "utf8");
      await execFileAsync("git", ["apply", "--reject", "--whitespace=nowarn", patchPath], { cwd: worktreePath, env: process.env });

      const changedFiles = await collectChangedFiles(worktreePath);
      const artifact = await publishBranchAndPullRequest({
        github: this.options.github,
        owner: this.options.owner,
        repo: this.options.repo,
        worktreePath,
        task,
        summaryText: parsed.summary,
        changedFiles,
        runId
      });

      run = {
        ...run,
        status: "completed",
        finishedAt: new Date().toISOString(),
        result: "pr_opened",
        traceId: parsed.responseId,
        summary: parsed.summary,
        usage: parsed.usage,
        metadata: { branch, responseId: parsed.responseId, attempts }
      };
      this.runs.set(runId, { run, artifact });
      return run;
    } catch (error) {
      run = {
        ...run,
        status: "failed",
        finishedAt: new Date().toISOString(),
        result: "failed",
        summary: error instanceof Error ? error.message : String(error),
        metadata: {
          branch,
          phase: "provider_execution",
          errorName: error instanceof Error ? error.name : "Error",
          stack: error instanceof Error ? error.stack : undefined
        }
      };
      this.runs.set(runId, { run, artifact: null });
      return run;
    } finally {
      await execGit(this.options.repoRoot, ["checkout", task.baseBranch]).catch(() => undefined);
      await execGit(this.options.repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async getRun(runId: string): Promise<ImplementationRun | null> {
    return this.runs.get(runId)?.run ?? null;
  }

  async cancelRun(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) {
      return;
    }
    entry.run = {
      ...entry.run,
      status: "canceled",
      finishedAt: new Date().toISOString(),
      result: entry.run.result ?? "blocked"
    };
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
}): Promise<ImplementationArtifact> {
  await execGit(params.worktreePath, ["config", "user.name", "github-actions[bot]"]);
  await execGit(params.worktreePath, ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  await execGit(params.worktreePath, ["add", "."]);
  await execGit(params.worktreePath, ["commit", "-m", `feat(factory): implement ${params.task.specId}`]);
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

function renderUserPrompt(task: ImplementationTask, contextText: string): string {
  return [
    `Implement accepted spec ${task.specId}.`,
    `Allowed paths: ${task.allowedPaths.join(", ")}.`,
    `Blocked paths: ${task.policy.blockedPaths.join(", ")}.`,
    `Required scenarios: ${task.verificationTargets.join(", ")}.`,
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
    "If the task is blocked, explain why in SUMMARY and return an empty PATCH section.",
    "",
    "Context bundle:",
    contextText
  ].join("\n");
}

function renderRepairPrompt(task: ImplementationTask, contextText: string, priorOutput: string, validationError: string): string {
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
    `Allowed paths: ${task.allowedPaths.join(", ")}.`,
    `Blocked paths: ${task.policy.blockedPaths.join(", ")}.`
  ].join("\n");
}

function renderApplyRepairPrompt(
  task: ImplementationTask,
  contextText: string,
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
    `Allowed paths: ${task.allowedPaths.join(", ")}.`,
    `Blocked paths: ${task.policy.blockedPaths.join(", ")}.`,
    "Do not modify unrelated files such as README.md unless the spec explicitly requires it."
  ].join("\n");
}

async function requestCodexResponse(apiKey: string, task: ImplementationTask, branch: string, prompt: string): Promise<ParsedCodexResponse> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-5-codex",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: SYSTEM_PROMPT }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      ],
      text: { format: { type: "text" } },
      metadata: {
        specId: task.specId,
        taskId: task.taskId,
        branch
      }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI Responses API failed: ${response.status} ${(await response.text()).trim()}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  const inputTokens = Number((payload.usage as Record<string, unknown> | undefined)?.input_tokens ?? 0);
  const outputTokens = Number((payload.usage as Record<string, unknown> | undefined)?.output_tokens ?? 0);
  const rawText = extractOutputText(payload);
  return {
    responseId: typeof payload.id === "string" ? payload.id : undefined,
    rawText,
    summary: extractSummary(rawText),
    patch: extractPatch(rawText),
    usage: {
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateCost(inputTokens, outputTokens)
    }
  };
}

function extractOutputText(payload: Record<string, unknown>): string {
  const direct = payload.output_text;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const text = output
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const content = Array.isArray((entry as { content?: unknown[] }).content) ? (entry as { content: unknown[] }).content : [];
      return content
        .map((part) => {
          if (!part || typeof part !== "object") {
            return "";
          }
          return typeof (part as { text?: unknown }).text === "string" ? String((part as { text?: unknown }).text) : "";
        })
        .filter(Boolean);
    })
    .join("\n")
    .trim();

  return text || "SUMMARY:\nCodex run completed without textual summary.\nPATCH:\n```diff\n\n```";
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

function estimateCost(inputTokens: number, outputTokens: number): number {
  return Number((((inputTokens / 1_000_000) * 1.25) + ((outputTokens / 1_000_000) * 10)).toFixed(6));
}

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("git", args, { cwd, env: process.env });
}

const SYSTEM_PROMPT = [
  "You are the dark factory implementation worker.",
  "Implement only the accepted spec described by the caller.",
  "Stay inside the allowed paths.",
  "Produce a small, reviewable unified diff.",
  "Prefer code and tests over prose.",
  "If the spec is ambiguous or unsafe, stop and explain the blocker."
].join(" ");

export const codexProviderInternals = {
  extractOutputText,
  extractSummary,
  extractPatch,
  checkPatchText,
  isLikelyUnifiedDiff,
  renderRepairPrompt,
  renderApplyRepairPrompt,
  extractPatchedPaths
};
