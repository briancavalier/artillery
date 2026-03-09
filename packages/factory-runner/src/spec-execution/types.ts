import type { SpecStatus } from "@darkfactory/contracts";

export interface ExecutionQueueItem {
  specId: string;
  taskId: string;
  branchName: string;
  status: string;
  created: boolean;
}

export interface ExecutionAdvanceItem {
  specId: string;
  previousStatus: SpecStatus;
  finalStatus: SpecStatus;
  taskStatus: string;
  evidenceGenerated: number;
  passedEvidence: number;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
}

export interface ExecutionManifest {
  version: "v1";
  generatedAt: string;
  repository?: string;
  branch?: string;
  commitSha?: string;
  queued: ExecutionQueueItem[];
  advanced: ExecutionAdvanceItem[];
}

export interface ExecutionPullRequest {
  number: number;
  htmlUrl: string;
}

export interface SpecExecutionGitHubApi {
  getBranchSha(owner: string, repo: string, branch: string): Promise<string>;
  createBranch(owner: string, repo: string, branch: string, sha: string): Promise<void>;
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<{ sha: string } | null>;
  putFileContent(params: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    message: string;
    content: string;
    sha?: string;
  }): Promise<void>;
  findPullRequestByHead(owner: string, repo: string, head: string): Promise<ExecutionPullRequest | null>;
  createPullRequest(params: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<ExecutionPullRequest>;
}
