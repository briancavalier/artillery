import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FeatureSpec } from "@darkfactory/contracts";
import { runPipelineStep, type FactoryAdapter } from "@darkfactory/core";
import type {
  ExecutionAdvanceItem,
  ExecutionManifest,
  ExecutionQueueItem,
  SpecExecutionGitHubApi
} from "./types.js";

export interface RunSpecExecutionOptions {
  adapter: FactoryAdapter;
  github?: SpecExecutionGitHubApi;
  owner?: string;
  repo?: string;
  baseBranch?: string;
  commitSha?: string;
  actor?: string;
  source?: string;
  deployId?: string;
  reportRootDir?: string;
  queuePullRequests?: boolean;
  advanceSpecs?: boolean;
}

export async function runSpecExecution(options: RunSpecExecutionOptions): Promise<{ manifest: ExecutionManifest }> {
  const actor = options.actor ?? "spec_executor";
  const source = options.source ?? "darkfactory.execution";
  const deployId = options.deployId ?? `spec-execution-${Date.now()}`;
  const specs = await options.adapter.listSpecs();
  const acceptedSpecs = specs
    .filter((record) => record.data.decision === "accept" && ["Approved", "Implemented"].includes(record.data.status));

  const manifest: ExecutionManifest = {
    version: "v1",
    generatedAt: new Date().toISOString(),
    repository: options.owner && options.repo ? `${options.owner}/${options.repo}` : undefined,
    branch: options.baseBranch,
    commitSha: options.commitSha,
    queued: [],
    advanced: []
  };

  if (options.queuePullRequests !== false && options.github && options.owner && options.repo && options.baseBranch) {
    for (const record of acceptedSpecs.filter((entry) => entry.data.status === "Approved")) {
      const queued = await ensureImplementationPullRequest({
        github: options.github,
        owner: options.owner,
        repo: options.repo,
        baseBranch: options.baseBranch,
        baseSha: options.commitSha ?? await options.github.getBranchSha(options.owner, options.repo, options.baseBranch),
        spec: record.data
      });
      manifest.queued.push(queued);
      await appendExecutionEvent(options.adapter, {
        specId: record.data.specId,
        scenarioId: firstScenario(record.data),
        deployId,
        actor,
        source,
        action: queued.created ? "spec_execution_pr_created" : "spec_execution_pr_exists",
        metadata: {
          branchName: queued.branchName,
          pullRequestNumber: queued.pullRequestNumber ?? 0,
          pullRequestUrl: queued.pullRequestUrl ?? ""
        }
      });
    }
  }

  if (options.advanceSpecs !== false) {
    for (const record of acceptedSpecs) {
      const previousStatus = record.data.status;
      if (record.data.status === "Approved") {
        await runPipelineStep(options.adapter, {
          step: "implement",
          specId: record.data.specId,
          actor,
          source,
          deployId
        });
      }

      let evidenceGenerated = 0;
      let passedEvidence = 0;
      if (options.adapter.generateScenarioEvidence) {
        const evidence = await options.adapter.generateScenarioEvidence(record.data.specId, {
          actor,
          source,
          deployId
        });
        evidenceGenerated = evidence.length;
        passedEvidence = evidence.filter((entry) => entry.passed).length;
      }

      await runPipelineStep(options.adapter, {
        step: "verify",
        specId: record.data.specId,
        actor,
        source,
        deployId
      });

      const updated = await options.adapter.readSpecById(record.data.specId);
      manifest.advanced.push({
        specId: record.data.specId,
        previousStatus,
        finalStatus: updated?.data.status ?? record.data.status,
        evidenceGenerated,
        passedEvidence
      });
    }
  }

  if (options.reportRootDir) {
    const reportPath = join(options.reportRootDir, "reports/spec-execution/latest.json");
    await mkdir(join(options.reportRootDir, "reports/spec-execution"), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  return { manifest };
}

async function ensureImplementationPullRequest(params: {
  github: SpecExecutionGitHubApi;
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  spec: FeatureSpec;
}): Promise<ExecutionQueueItem> {
  const branchName = `codex/implement-${params.spec.specId.toLowerCase()}`;
  const existing = await params.github.findPullRequestByHead(params.owner, params.repo, `${params.owner}:${branchName}`);
  const trackingPath = `ops/spec-execution/${params.spec.specId}.json`;
  const evidenceReadmePath = `evidence/${params.spec.specId}/README.md`;

  if (existing) {
    return {
      specId: params.spec.specId,
      title: params.spec.title,
      branchName,
      prTitle: implementationPrTitle(params.spec),
      prBody: implementationPrBody(params.spec),
      trackingPath,
      evidenceReadmePath,
      created: false,
      pullRequestNumber: existing.number,
      pullRequestUrl: existing.htmlUrl
    };
  }

  await params.github.createBranch(params.owner, params.repo, branchName, params.baseSha);

  await upsertFile(params.github, {
    owner: params.owner,
    repo: params.repo,
    branch: branchName,
    path: trackingPath,
    message: `chore(factory): queue implementation for ${params.spec.specId}`,
    content: JSON.stringify({
      version: "v1",
      specId: params.spec.specId,
      title: params.spec.title,
      status: "queued",
      branchName,
      generatedAt: new Date().toISOString(),
      requiredScenarios: params.spec.scenarios.filter((scenario) => scenario.required).map((scenario) => scenario.id)
    }, null, 2) + "\n"
  });

  await upsertFile(params.github, {
    owner: params.owner,
    repo: params.repo,
    branch: branchName,
    path: evidenceReadmePath,
    message: `docs(factory): seed evidence plan for ${params.spec.specId}`,
    content: evidenceReadme(params.spec)
  });

  const pull = await params.github.createPullRequest({
    owner: params.owner,
    repo: params.repo,
    head: branchName,
    base: params.baseBranch,
    title: implementationPrTitle(params.spec),
    body: implementationPrBody(params.spec),
    draft: true
  });

  return {
    specId: params.spec.specId,
    title: params.spec.title,
    branchName,
    prTitle: implementationPrTitle(params.spec),
    prBody: implementationPrBody(params.spec),
    trackingPath,
    evidenceReadmePath,
    created: true,
    pullRequestNumber: pull.number,
    pullRequestUrl: pull.htmlUrl
  };
}

async function upsertFile(
  github: SpecExecutionGitHubApi,
  params: {
    owner: string;
    repo: string;
    branch: string;
    path: string;
    message: string;
    content: string;
  }
): Promise<void> {
  const existing = await github.getFileContent(params.owner, params.repo, params.path, params.branch);
  await github.putFileContent({
    owner: params.owner,
    repo: params.repo,
    path: params.path,
    branch: params.branch,
    message: params.message,
    content: params.content,
    sha: existing?.sha
  });
}

function implementationPrTitle(spec: FeatureSpec): string {
  return `Implement ${spec.specId}: ${spec.title}`;
}

function implementationPrBody(spec: FeatureSpec): string {
  const scenarios = spec.scenarios
    .map((scenario) => `- ${scenario.id}: ${scenario.description}`)
    .join("\n");

  return [
    `Automated implementation queue for \`${spec.specId}\`.`,
    "",
    "## Required Scenarios",
    scenarios,
    "",
    "## Exit Criteria",
    "- implementation code merged",
    "- scenario evidence generated for all required scenarios",
    "- spec advances to `Verified` without manual status edits"
  ].join("\n");
}

function evidenceReadme(spec: FeatureSpec): string {
  const verification = spec.verification
    .map((entry) => `- ${entry.scenarioId}: ${entry.checks.join(", ")}`)
    .join("\n");

  return [
    `# Evidence Plan for ${spec.specId}`,
    "",
    "Required verification checks:",
    verification,
    "",
    "This file is factory-generated to seed the implementation branch."
  ].join("\n") + "\n";
}

async function appendExecutionEvent(
  adapter: FactoryAdapter,
  params: {
    specId: string;
    scenarioId: string;
    deployId: string;
    actor: string;
    source: string;
    action: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  await adapter.appendEvent({
    specversion: "1.0",
    id: randomUUID(),
    source: params.source,
    type: "pipeline_event",
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: {
      action: params.action,
      actor: params.actor,
      specId: params.specId,
      scenarioId: params.scenarioId,
      deployId: params.deployId,
      matchId: "MATCH-UNBOUND",
      metadata: params.metadata
    }
  });
}

function firstScenario(spec: FeatureSpec): string {
  return spec.scenarios[0]?.id ?? "SCN-UNBOUND";
}
