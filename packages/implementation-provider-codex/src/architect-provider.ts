import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArchitectureArtifact, ArchitectureRun, ArchitectureTask, FeatureSpec } from "@darkfactory/contracts";
import type { ArchitectureContext, ArchitectureProvider } from "@darkfactory/core";
import { GitHubAutomationApi } from "./github.js";
import { codexProviderInternals } from "./provider.js";
import { OpenAiRequestError, type OpenAiRequestDiagnostics, requestOpenAiText } from "./openai.js";

const execFileAsync = promisify(execFile);

interface ArchitectProviderOptions {
  token: string;
  owner: string;
  repo: string;
  repoRoot: string;
  github: GitHubAutomationApi;
}

interface StoredRun {
  run: ArchitectureRun;
  artifact: ArchitectureArtifact | null;
}

interface ParsedArchitectureContext {
  spec: Pick<FeatureSpec, "specId" | "title" | "intent" | "riskNotes" | "verification"> & {
    scenarios: Array<{ id: string; description: string; required: boolean }>;
  };
  context: Pick<
    ArchitectureContext,
    "relevantFiles" | "readPaths" | "seedFiles" | "discoveryGoals" | "reviewNotes" | "artifactRoot" | "blockedPaths"
  > | null;
}

interface ArchitecturePayload {
  readme: string;
  integrationPoints: Array<{
    path: string;
    role: string;
    writeIntent: "edit" | "read-only";
    priority: number;
  }>;
  invariants: string[];
  scenarioTrace: Array<{
    scenarioId: string;
    filePaths: string[];
    evidenceHooks: string[];
  }>;
}

interface ArchitectureResponse {
  payload: ArchitecturePayload;
  responseId?: string;
  diagnostics: OpenAiRequestDiagnostics;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

export class CodexArchitectureProvider implements ArchitectureProvider {
  private readonly runs = new Map<string, StoredRun>();

  constructor(private readonly options: ArchitectProviderOptions) {}

  async startTask(task: ArchitectureTask): Promise<ArchitectureRun> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const worktreePath = join(tmpdir(), `darkfactory-architect-${task.specId.toLowerCase()}-${Date.now()}`);
    let run: ArchitectureRun = {
      runId,
      taskId: task.taskId,
      provider: "openai-codex-architect",
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
        summary: "OPENAI_API_KEY is not configured"
      };
      this.runs.set(runId, { run, artifact: null });
      return run;
    }

    try {
      await this.options.github.createOrResetBranch(this.options.owner, this.options.repo, task.targetBranch, task.baseSha);
      await execGit(this.options.repoRoot, ["worktree", "add", "-B", task.targetBranch, worktreePath, task.baseSha]);
      await execGit(worktreePath, ["checkout", task.targetBranch]);

      const contextText = await readContext(task.contextBundleRef);
      const discovery = await discoverArchitectureContext(worktreePath, contextText);
      const prompt = renderArchitectPrompt(task, contextText, discovery.promptContext);
      const attempts: Array<Record<string, unknown>> = [];

      let response: ArchitectureResponse;
      let responseId: string | undefined;
      let diagnostics;
      try {
        response = await requestArchitecturePayload(apiKey, task, prompt);
        responseId = response.responseId;
        diagnostics = response.diagnostics;
        attempts.push({ attempt: 1, responseId, repaired: false });
      } catch (error) {
        if (!(error instanceof InvalidArchitectureResponseError)) {
          throw error;
        }
        attempts.push({ attempt: 1, repaired: false, error: error.message });
        response = await requestArchitecturePayload(apiKey, task, renderArchitectRepairPrompt(contextText, discovery.promptContext, error.rawText));
        responseId = response.responseId;
        diagnostics = response.diagnostics;
        attempts.push({ attempt: 2, repaired: true, responseId });
      }

      const artifact = await publishArchitectureArtifacts({
        github: this.options.github,
        owner: this.options.owner,
        repo: this.options.repo,
        task,
        worktreePath,
        payload: response.payload,
        summaryText: response.payload.readme,
        runId
      });

      run = {
        ...run,
        status: "completed",
        finishedAt: new Date().toISOString(),
        result: "pr_opened",
        traceId: responseId,
        summary: response.payload.readme,
        usage: response.usage,
        metadata: {
          selectedContextFiles: discovery.selectedContextFiles,
          requestDiagnostics: diagnostics,
          attempts
        }
      };
      this.runs.set(runId, { run, artifact });
      return run;
    } catch (error) {
      run = {
        ...run,
        status: error instanceof OpenAiRequestError ? "failed" : "blocked",
        finishedAt: new Date().toISOString(),
        result: error instanceof OpenAiRequestError ? "failed" : "blocked",
        summary: error instanceof Error ? error.message : String(error),
        metadata: {
          requestDiagnostics: error instanceof OpenAiRequestError ? error.diagnostics : undefined,
          errorName: error instanceof Error ? error.name : "Error"
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

  async getRun(runId: string): Promise<ArchitectureRun | null> {
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
      finishedAt: new Date().toISOString()
    };
    this.runs.set(runId, entry);
  }

  async collectArtifacts(runId: string): Promise<ArchitectureArtifact | null> {
    return this.runs.get(runId)?.artifact ?? null;
  }
}

class InvalidArchitectureResponseError extends Error {
  constructor(message: string, readonly rawText: string) {
    super(message);
    this.name = "InvalidArchitectureResponseError";
  }
}

async function requestArchitecturePayload(apiKey: string, task: ArchitectureTask, prompt: string): Promise<ArchitectureResponse> {
  const { payload, diagnostics } = await requestOpenAiText(apiKey, {
    model: process.env.OPENAI_MODEL ?? "gpt-5-codex",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: ARCHITECT_SYSTEM_PROMPT }]
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
      branch: task.targetBranch,
      stage: "architect"
    }
  });
  const rawText = extractOutputText(payload);
  const inputTokens = Number((payload.usage as Record<string, unknown> | undefined)?.input_tokens ?? 0);
  const outputTokens = Number((payload.usage as Record<string, unknown> | undefined)?.output_tokens ?? 0);
  return {
    payload: parseArchitecturePayload(rawText),
    responseId: typeof payload.id === "string" ? payload.id : undefined,
    diagnostics,
    usage: {
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateCost(inputTokens, outputTokens)
    }
  };
}

async function discoverArchitectureContext(worktreePath: string, contextText: string): Promise<{
  selectedContextFiles: string[];
  promptContext: string;
}> {
  const parsed = parseArchitectureContext(contextText);
  const readPaths = parsed?.context?.readPaths?.length ? parsed.context.readPaths : ["**"];
  const seedFiles = [...new Set([...(parsed?.context?.seedFiles ?? []), ...(parsed?.context?.relevantFiles ?? [])])];
  const keywords = codexProviderInternals.extractDiscoveryKeywords({
    spec: parsed?.spec ?? {
      specId: "SPEC-UNKNOWN",
      title: "",
      intent: "",
      riskNotes: "",
      scenarios: [],
      verification: []
    },
    context: parsed?.context
      ? {
          ...parsed.context,
          discoveryBudget: { maxFiles: 24, maxBytes: 160_000 },
          allowedPaths: [],
          recommendedCommands: [],
          evidenceCapabilities: []
        }
      : null
  });
  const repoFiles = await codexProviderInternals.listRepoFiles(worktreePath, readPaths);
  const contentMatches = new Set<string>();
  const candidates = codexProviderInternals.scoreDiscoveryCandidates(repoFiles, seedFiles, contentMatches, keywords);
  const selection = await codexProviderInternals.selectContextFiles(worktreePath, candidates, { maxFiles: 24, maxBytes: 160_000 });
  return {
    selectedContextFiles: selection.selectedFiles,
    promptContext: codexProviderInternals.renderDiscoveredContext(selection.snapshots, parsed?.context?.discoveryGoals ?? [])
  };
}

function parseArchitectureContext(contextText: string): ParsedArchitectureContext | null {
  const match = contextText.match(/## Architecture Metadata\s+```json\n([\s\S]*?)\n```/i);
  if (!match?.[1]) {
    return null;
  }
  try {
    return JSON.parse(match[1]) as ParsedArchitectureContext;
  } catch {
    return null;
  }
}

function renderArchitectPrompt(task: ArchitectureTask, contextText: string, discoveredContext: string): string {
  return [
    `Investigate accepted spec ${task.specId} and produce architecture artifacts only.`,
    `You may write only under ${task.artifactRoot}.`,
    "Return JSON only with keys: readme, integrationPoints, invariants, scenarioTrace.",
    "integrationPoints entries must include path, role, writeIntent, priority.",
    "scenarioTrace entries must include scenarioId, filePaths, evidenceHooks.",
    "Do not produce a patch.",
    "",
    contextText,
    "",
    discoveredContext
  ].join("\n");
}

function renderArchitectRepairPrompt(contextText: string, discoveredContext: string, priorOutput: string): string {
  return [
    "Your previous response was not valid architecture JSON.",
    "Return JSON only with keys: readme, integrationPoints, invariants, scenarioTrace.",
    "Do not wrap the JSON in markdown fences.",
    "",
    "Previous invalid output:",
    priorOutput,
    "",
    contextText,
    "",
    discoveredContext
  ].join("\n");
}

function parseArchitecturePayload(rawText: string): ArchitecturePayload {
  try {
    const payload = JSON.parse(rawText) as ArchitecturePayload;
    if (!payload.readme || !Array.isArray(payload.integrationPoints) || !Array.isArray(payload.invariants) || !Array.isArray(payload.scenarioTrace)) {
      throw new Error("Architecture payload missing required fields");
    }
    return payload;
  } catch (error) {
    throw new InvalidArchitectureResponseError(error instanceof Error ? error.message : "Invalid architecture JSON", rawText);
  }
}

async function publishArchitectureArtifacts(params: {
  github: GitHubAutomationApi;
  owner: string;
  repo: string;
  task: ArchitectureTask;
  worktreePath: string;
  payload: ArchitecturePayload;
  summaryText: string;
  runId: string;
}): Promise<ArchitectureArtifact> {
  const artifactDir = join(params.worktreePath, params.task.artifactRoot);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "README.md"), `${params.payload.readme.trim()}\n`, "utf8");
  await writeFile(join(artifactDir, "integration-points.json"), `${JSON.stringify(params.payload.integrationPoints, null, 2)}\n`, "utf8");
  await writeFile(join(artifactDir, "invariants.json"), `${JSON.stringify(params.payload.invariants, null, 2)}\n`, "utf8");
  await writeFile(join(artifactDir, "scenario-trace.json"), `${JSON.stringify(params.payload.scenarioTrace, null, 2)}\n`, "utf8");

  await execGit(params.worktreePath, ["config", "user.name", "github-actions[bot]"]);
  await execGit(params.worktreePath, ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  await execGit(params.worktreePath, ["add", params.task.artifactRoot]);
  await execGit(params.worktreePath, ["commit", "-m", `docs(factory): architect ${params.task.specId}`]);
  await execGit(params.worktreePath, ["push", "-u", "origin", params.task.targetBranch]);

  const existing = await params.github.findPullRequestByHead(params.owner, params.repo, `${params.owner}:${params.task.targetBranch}`);
  const pull = existing ?? await params.github.createPullRequest({
    owner: params.owner,
    repo: params.repo,
    head: params.task.targetBranch,
    base: params.task.baseBranch,
    title: `Architect ${params.task.specId}`,
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
    filesChanged: [
      `${params.task.artifactRoot}/README.md`,
      `${params.task.artifactRoot}/integration-points.json`,
      `${params.task.artifactRoot}/invariants.json`,
      `${params.task.artifactRoot}/scenario-trace.json`
    ],
    summaryMd: params.summaryText,
    payload: params.payload,
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

function extractOutputText(payload: Record<string, unknown>): string {
  const direct = payload.output_text;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const content = Array.isArray((entry as { content?: unknown[] }).content) ? (entry as { content: unknown[] }).content : [];
      return content.map((part) => (typeof (part as { text?: unknown }).text === "string" ? String((part as { text?: unknown }).text) : ""));
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  return Number((((inputTokens / 1_000_000) * 1.25) + ((outputTokens / 1_000_000) * 10)).toFixed(6));
}

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync("git", args, { cwd, env: process.env });
}

const ARCHITECT_SYSTEM_PROMPT = [
  "You are the dark factory architecture worker.",
  "Investigate the repository and accepted spec.",
  "Produce architecture artifacts only.",
  "List integration points, invariants, and scenario traces with concrete file paths.",
  "If the spec cannot be mapped safely, say so in the README field and keep the structure valid."
].join(" ");
