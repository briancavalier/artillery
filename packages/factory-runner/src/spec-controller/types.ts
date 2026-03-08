import type { FeatureSpec, SpecStatus } from "@darkfactory/contracts";

export type DecisionLabel = "factory/accept" | "factory/veto" | "factory/rollback";

export interface PullRequestSummary {
  number: number;
  headRef: string;
  headSha: string;
  headRepoFullName: string;
  baseRepoFullName: string;
  labels: string[];
}

export interface PullRequestFile {
  filename: string;
  status: string;
}

export interface PullRequestComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface RepositoryContent {
  path: string;
  sha: string;
  content: string;
}

export interface SpecFileState {
  path: string;
  sha: string;
  spec: FeatureSpec;
}

export interface SpecAnalysis {
  path: string;
  specId: string;
  scenarioId: string;
  currentStatus: SpecStatus;
  nextStatus: SpecStatus;
  changed: boolean;
  readiness: "ready-for-decision" | "needs-refinement";
  score: number;
  issues: string[];
  blockers: string[];
  updatedSpec: FeatureSpec;
}

export interface SpecControllerManifest {
  version: "v1";
  generatedAt: string;
  mode: "analyze" | "act";
  repository: string;
  prNumber: number;
  headSha: string;
  sameRepo: boolean;
  changedSpecPaths: string[];
  analyses: Array<{
    specId: string;
    path: string;
    currentStatus: SpecStatus;
    nextStatus: SpecStatus;
    changed: boolean;
    readiness: "ready-for-decision" | "needs-refinement";
    score: number;
    blockers: string[];
    issues: string[];
  }>;
  autoUpdate: {
    attempted: boolean;
    updatedSpecIds: string[];
    skippedReason?: string;
  };
  action: {
    label?: DecisionLabel;
    actor?: string;
    result: "not_requested" | "applied" | "rejected";
    message: string;
    specId?: string;
    reason?: string;
  };
}

export interface GitHubApi {
  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<PullRequestSummary>;
  listPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<PullRequestFile[]>;
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<RepositoryContent>;
  putFileContent(params: {
    owner: string;
    repo: string;
    path: string;
    branch: string;
    message: string;
    content: string;
    sha: string;
  }): Promise<{ sha: string }>;
  listIssueComments(owner: string, repo: string, issueNumber: number): Promise<PullRequestComment[]>;
  createIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void>;
  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<void>;
  removeIssueLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void>;
  getRepositoryPermission(owner: string, repo: string, username: string): Promise<string>;
}

export interface ControllerEvent {
  actor?: string;
  label?: string;
}
