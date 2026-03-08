import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createTempWorkspace, readJson, writeJson } from "./helpers.js";
import { createArtilleryAdapter } from "../packages/project-adapter-artillery/src/index.js";
import { runSpecExecution } from "../packages/factory-runner/src/spec-execution/controller.js";
import type { FeatureSpec } from "@darkfactory/contracts";
import type { ExecutionPullRequest, SpecExecutionGitHubApi } from "../packages/factory-runner/src/spec-execution/types.js";

class MockExecutionGitHubApi implements SpecExecutionGitHubApi {
  branches = new Map<string, string>();
  files = new Map<string, string>();
  pulls = new Map<string, ExecutionPullRequest>();
  counter = 1;

  async getBranchSha(_owner: string, _repo: string, branch: string): Promise<string> {
    return this.branches.get(branch) ?? "base-sha";
  }

  async createBranch(_owner: string, _repo: string, branch: string, sha: string): Promise<void> {
    this.branches.set(branch, sha);
  }

  async getFileContent(_owner: string, _repo: string, path: string, ref: string): Promise<{ sha: string } | null> {
    return this.files.has(`${ref}:${path}`) ? { sha: "sha-1" } : null;
  }

  async putFileContent(params: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    message: string;
    content: string;
    sha?: string;
  }): Promise<void> {
    this.files.set(`${params.branch}:${params.path}`, params.content);
  }

  async findPullRequestByHead(_owner: string, _repo: string, head: string): Promise<ExecutionPullRequest | null> {
    return this.pulls.get(head) ?? null;
  }

  async createPullRequest(params: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<ExecutionPullRequest> {
    const pull = {
      number: this.counter++,
      htmlUrl: `https://example.test/${params.head}`
    };
    this.pulls.set(`${params.owner}:${params.head}`, pull);
    return pull;
  }
}

function makeSpec(status: FeatureSpec["status"], scenarioIds: string[]): FeatureSpec {
  return {
    specId: "SPEC-EXEC-1",
    title: "Execution controller",
    source: "human",
    owner: "@maintainer",
    status,
    decision: "accept",
    intent: "Advance accepted specs through implementation and verification when adapter evidence can prove the scenarios.",
    scenarios: scenarioIds.map((id) => ({ id, description: `Scenario ${id}`, required: true })),
    verification: scenarioIds.map((id) => ({ scenarioId: id, checks: ["integration"] })),
    riskNotes: "Risk: unsupported scenarios stall. Mitigation: preserve failed evidence rather than promoting the spec.",
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z"
  };
}

test("execution controller queues implementation pull requests for approved specs", async () => {
  const workspace = await createTempWorkspace();
  await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Approved", ["SCN-0999"]));
  const adapter = createArtilleryAdapter({
    specDir: join(workspace, "specs"),
    evidenceDir: join(workspace, "evidence"),
    ledgerPath: join(workspace, "var/ledger/events.ndjson"),
    evaluationsDir: join(workspace, "reports/evaluations"),
    canaryPath: join(workspace, "ops/canary/latest.json"),
    dryRun: false,
    localEventMode: true
  } as never);
  const github = new MockExecutionGitHubApi();

  const result = await runSpecExecution({
    adapter,
    github,
    owner: "owner",
    repo: "repo",
    baseBranch: "main",
    commitSha: "base-sha",
    queuePullRequests: true,
    advanceSpecs: false,
    reportRootDir: workspace
  });

  assert.equal(result.manifest.queued.length, 1);
  assert.equal(result.manifest.queued[0]?.created, true);
  assert.ok(github.files.has("codex/implement-spec-exec-1:ops/spec-execution/SPEC-EXEC-1.json"));
});

test("execution controller advances supported approved specs to verified", async () => {
  const workspace = await createTempWorkspace();
  await writeJson(join(workspace, "specs/SPEC-EXEC-1.json"), makeSpec("Approved", ["SCN-0001", "SCN-0002", "SCN-0003"]));
  const adapter = createArtilleryAdapter({
    specDir: join(workspace, "specs"),
    evidenceDir: join(workspace, "evidence"),
    ledgerPath: join(workspace, "var/ledger/events.ndjson"),
    evaluationsDir: join(workspace, "reports/evaluations"),
    canaryPath: join(workspace, "ops/canary/latest.json"),
    dryRun: false,
    localEventMode: true
  } as never);

  const result = await runSpecExecution({
    adapter,
    queuePullRequests: false,
    advanceSpecs: true,
    reportRootDir: workspace
  });

  assert.equal(result.manifest.advanced[0]?.finalStatus, "Verified");
  const stored = await readJson<{ status: string }>(join(workspace, "specs/SPEC-EXEC-1.json"));
  assert.equal(stored.status, "Verified");
});
