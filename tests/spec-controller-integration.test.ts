import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FeatureSpec } from "@darkfactory/contracts";
import { runSpecController } from "../packages/factory-runner/src/spec-controller/controller.js";
import type {
  GitHubApi,
  PullRequestComment,
  PullRequestFile,
  PullRequestSummary,
  RepositoryContent
} from "../packages/factory-runner/src/spec-controller/types.js";

class MockGitHubApi implements GitHubApi {
  comments: PullRequestComment[] = [];
  removedLabels: string[] = [];
  putCount = 0;
  permission = "write";
  private shaCounter = 1;
  constructor(
    public readonly pull: PullRequestSummary,
    public readonly files: PullRequestFile[],
    public readonly contents: Map<string, RepositoryContent>
  ) {}

  async getPullRequest(_owner: string, _repo: string, _pullNumber: number): Promise<PullRequestSummary> {
    return this.pull;
  }

  async listPullRequestFiles(_owner: string, _repo: string, _pullNumber: number): Promise<PullRequestFile[]> {
    return this.files;
  }

  async getFileContent(_owner: string, _repo: string, path: string): Promise<RepositoryContent> {
    const entry = this.contents.get(path);
    if (!entry) {
      throw new Error(`Missing content for ${path}`);
    }
    return entry;
  }

  async putFileContent(params: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    message: string;
    content: string;
    sha: string;
  }): Promise<{ sha: string }> {
    this.putCount += 1;
    const nextSha = `sha-${this.shaCounter++}`;
    this.contents.set(params.path, {
      path: params.path,
      sha: nextSha,
      content: params.content
    });
    return { sha: nextSha };
  }

  async listIssueComments(_owner: string, _repo: string, _issueNumber: number): Promise<PullRequestComment[]> {
    return this.comments;
  }

  async createIssueComment(_owner: string, _repo: string, _issueNumber: number, body: string): Promise<void> {
    this.comments.push({
      id: this.comments.length + 1,
      body,
      userLogin: "github-actions[bot]",
      createdAt: new Date(this.comments.length + 1).toISOString()
    });
  }

  async updateIssueComment(_owner: string, _repo: string, commentId: number, body: string): Promise<void> {
    const comment = this.comments.find((entry) => entry.id === commentId);
    if (!comment) {
      throw new Error("comment not found");
    }
    comment.body = body;
  }

  async removeIssueLabel(_owner: string, _repo: string, _issueNumber: number, label: string): Promise<void> {
    this.removedLabels.push(label);
  }

  async getRepositoryPermission(_owner: string, _repo: string, _username: string): Promise<string> {
    return this.permission;
  }
}

function makeSpec(status: FeatureSpec["status"] = "Draft"): FeatureSpec {
  return {
    specId: "SPEC-INT-1",
    title: "Integration spec",
    source: "human",
    owner: "@maintainer",
    status,
    decision: "pending",
    intent: "Intent statement long enough to pass critic checks and enable automated refinement.",
    scenarios: [
      { id: "SCN-INT-1", description: "scenario one", required: true },
      { id: "SCN-INT-2", description: "scenario two", required: true }
    ],
    verification: [
      { scenarioId: "SCN-INT-1", checks: ["unit"] },
      { scenarioId: "SCN-INT-2", checks: ["e2e"] }
    ],
    riskNotes: "Risk: regressions. Mitigation: scenario verification and canary gates.",
    createdAt: "2026-03-08T00:00:00.000Z",
    updatedAt: "2026-03-08T00:00:00.000Z"
  };
}

function makePull(sameRepo: boolean): PullRequestSummary {
  return {
    number: 7,
    headRef: "codex/spec-test",
    headSha: "abc123def456",
    headRepoFullName: sameRepo ? "owner/repo" : "fork/repo",
    baseRepoFullName: "owner/repo",
    labels: []
  };
}

test("same-repo act run auto-refines and commits spec updates", async () => {
  const spec = makeSpec("Draft");
  const api = new MockGitHubApi(
    makePull(true),
    [{ filename: "specs/SPEC-INT-1.json", status: "modified" }],
    new Map([
      ["specs/SPEC-INT-1.json", { path: "specs/SPEC-INT-1.json", sha: "sha-0", content: JSON.stringify(spec) }]
    ])
  );
  const reportRoot = await mkdtemp(join(tmpdir(), "spec-controller-report-"));

  const result = await runSpecController({
    api,
    owner: "owner",
    repo: "repo",
    prNumber: 7,
    mode: "act",
    deployId: "pr-7-act",
    reportRootDir: reportRoot
  });

  assert.deepEqual(result.manifest.autoUpdate.updatedSpecIds, ["SPEC-INT-1"]);
  assert.equal(api.putCount >= 1, true);
  const updated = JSON.parse(api.contents.get("specs/SPEC-INT-1.json")!.content) as FeatureSpec;
  assert.equal(updated.status, "Refined");
});

test("fork PR stays read-only", async () => {
  const spec = makeSpec("Draft");
  const api = new MockGitHubApi(
    makePull(false),
    [{ filename: "specs/SPEC-INT-1.json", status: "modified" }],
    new Map([
      ["specs/SPEC-INT-1.json", { path: "specs/SPEC-INT-1.json", sha: "sha-0", content: JSON.stringify(spec) }]
    ])
  );

  const result = await runSpecController({
    api,
    owner: "owner",
    repo: "repo",
    prNumber: 7,
    mode: "act",
    deployId: "pr-7-act"
  });

  assert.equal(result.manifest.autoUpdate.updatedSpecIds.length, 0);
  assert.equal(api.putCount, 0);
  assert.match(result.manifest.autoUpdate.skippedReason ?? "", /Fork PR/);
});

test("accept label updates spec to Approved", async () => {
  const spec = makeSpec("Refined");
  const api = new MockGitHubApi(
    makePull(true),
    [{ filename: "specs/SPEC-INT-1.json", status: "modified" }],
    new Map([
      ["specs/SPEC-INT-1.json", { path: "specs/SPEC-INT-1.json", sha: "sha-0", content: JSON.stringify(spec) }]
    ])
  );

  const result = await runSpecController({
    api,
    owner: "owner",
    repo: "repo",
    prNumber: 7,
    mode: "act",
    event: { label: "factory/accept", actor: "maintainer" },
    deployId: "pr-7-act"
  });

  assert.equal(result.manifest.action.result, "applied");
  const updated = JSON.parse(api.contents.get("specs/SPEC-INT-1.json")!.content) as FeatureSpec;
  assert.equal(updated.status, "Approved");
  assert.equal(updated.decision, "accept");
  assert.ok(api.removedLabels.includes("factory/accept"));
});

test("veto label without reason is rejected and does not mutate decision", async () => {
  const spec = makeSpec("Refined");
  const api = new MockGitHubApi(
    makePull(true),
    [{ filename: "specs/SPEC-INT-1.json", status: "modified" }],
    new Map([
      ["specs/SPEC-INT-1.json", { path: "specs/SPEC-INT-1.json", sha: "sha-0", content: JSON.stringify(spec) }]
    ])
  );

  const result = await runSpecController({
    api,
    owner: "owner",
    repo: "repo",
    prNumber: 7,
    mode: "act",
    event: { label: "factory/veto", actor: "maintainer" },
    deployId: "pr-7-act"
  });

  assert.equal(result.manifest.action.result, "rejected");
  const updated = JSON.parse(api.contents.get("specs/SPEC-INT-1.json")!.content) as FeatureSpec;
  assert.equal(updated.decision, "pending");
});

test("rollback label with reason updates status and decision", async () => {
  const spec = makeSpec("Deployed");
  const api = new MockGitHubApi(
    makePull(true),
    [{ filename: "specs/SPEC-INT-1.json", status: "modified" }],
    new Map([
      ["specs/SPEC-INT-1.json", { path: "specs/SPEC-INT-1.json", sha: "sha-0", content: JSON.stringify(spec) }]
    ])
  );
  api.comments.push({
    id: 1,
    userLogin: "maintainer",
    createdAt: "2026-03-08T03:00:00.000Z",
    body: "/factory-reason SPEC-INT-1: Canary regression"
  });

  const result = await runSpecController({
    api,
    owner: "owner",
    repo: "repo",
    prNumber: 7,
    mode: "act",
    event: { label: "factory/rollback", actor: "maintainer" },
    deployId: "pr-7-act"
  });

  assert.equal(result.manifest.action.result, "applied");
  const updated = JSON.parse(api.contents.get("specs/SPEC-INT-1.json")!.content) as FeatureSpec;
  assert.equal(updated.status, "Refined");
  assert.equal(updated.decision, "rollback");
});

test("analyze mode writes manifest", async () => {
  const spec = makeSpec("Draft");
  const api = new MockGitHubApi(
    makePull(true),
    [{ filename: "specs/SPEC-INT-1.json", status: "modified" }],
    new Map([
      ["specs/SPEC-INT-1.json", { path: "specs/SPEC-INT-1.json", sha: "sha-0", content: JSON.stringify(spec) }]
    ])
  );
  const reportRoot = await mkdtemp(join(tmpdir(), "spec-controller-report-"));
  const result = await runSpecController({
    api,
    owner: "owner",
    repo: "repo",
    prNumber: 7,
    mode: "analyze",
    deployId: "pr-7-analyze",
    reportRootDir: reportRoot
  });

  const raw = await readFile(result.manifestPath, "utf8");
  const manifest = JSON.parse(raw) as { mode: string };
  assert.equal(manifest.mode, "analyze");
});
