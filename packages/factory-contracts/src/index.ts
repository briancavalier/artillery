export type SpecSource = "human" | "agent";

export type SpecStatus =
  | "Draft"
  | "Critiqued"
  | "Refined"
  | "Approved"
  | "Architected"
  | "Implemented"
  | "Verified"
  | "Deployed";

export type SpecDecision = "pending" | "accept" | "veto" | "rollback";

export interface ScenarioSpec {
  id: string;
  description: string;
  required: boolean;
}

export interface VerificationRule {
  scenarioId: string;
  checks: string[];
}

export interface FeatureSpec {
  specId: string;
  title: string;
  source: SpecSource;
  owner: string;
  status: SpecStatus;
  decision: SpecDecision;
  intent: string;
  scenarios: ScenarioSpec[];
  verification: VerificationRule[];
  riskNotes: string;
  createdAt: string;
  updatedAt: string;
}

export type LedgerEventType =
  | "game_event"
  | "pipeline_event"
  | "agent_event"
  | "user_feedback"
  | "incident";

export interface CorrelationIds {
  specId: string;
  scenarioId: string;
  deployId: string;
  matchId: string;
}

export interface CloudEventEnvelope<TData = Record<string, unknown>> {
  specversion: "1.0";
  id: string;
  source: string;
  type: LedgerEventType;
  time: string;
  datacontenttype: "application/json";
  subject?: string;
  data: TData & CorrelationIds;
}

export interface ProjectHealthResponse {
  status: "ok" | "degraded";
  generatedAt: string;
  metrics: {
    matchesCreated: number;
    matchesCompleted: number;
    commandRejections: number;
    disconnects: number;
    completionRate: number;
  };
}

export interface ProjectCanaryResponse {
  pass: boolean;
  generatedAt: string;
  metrics: {
    rejectRate: number;
    disconnects: number;
  };
}

export interface ScenarioVerificationResponse {
  scenarioId: string;
  passed: boolean;
  details: Record<string, unknown>;
}

export interface FactoryEventsQuery {
  type?: LedgerEventType;
  action?: string;
  specId?: string;
  deployId?: string;
  matchId?: string;
  limit?: number;
  after?: string;
  order?: "asc" | "desc";
}

export interface FactoryEventsResponse {
  events: Array<CloudEventEnvelope<Record<string, unknown>>>;
}

export interface FactoryAdminStatus {
  generatedAt: string;
  status: "ok" | "degraded";
  pipeline: {
    queuedSpecs: number;
    gateFailures: number;
    deploymentsToday: number;
    rollbacksToday: number;
    architectureQueueDepth?: number;
    architectureMergedToday?: number;
    architectureBlockedToday?: number;
    implementationQueueDepth?: number;
    implementationMergedToday?: number;
    implementationBlockedToday?: number;
  };
}

export interface AgentQualityStatus {
  generatedAt: string;
  proposals: number;
  acceptedProposals: number;
  acceptanceRate: number;
  regressionRate: number;
}

export type ArchitectureTaskStatus =
  | "queued"
  | "running"
  | "blocked"
  | "failed"
  | "merged"
  | "aborted";

export type ArchitectureRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "canceled";

export type ArchitectureResult = "blocked" | "failed" | "pr_opened" | "merged";

export interface ArchitectureTaskLimits {
  maxDurationMs: number;
  maxCostUsd: number;
  maxFilesRead: number;
}

export interface ArchitectureTaskPolicy {
  allowAutoMerge: boolean;
  allowNetwork: boolean;
  blockedPaths: string[];
}

export interface ArchitectureArtifactPayload {
  readmeMd: string;
  integrationPoints: {
    path: string;
    role: string;
    writeIntent: "edit" | "read-only";
    priority: number;
  }[];
  invariants: {
    id: string;
    description: string;
    category: "determinism" | "fairness" | "performance" | "safety" | "protocol" | "testing";
  }[];
  scenarioTrace: {
    scenarioId: string;
    paths: string[];
    evidenceHooks: string[];
  }[];
}

export interface ArchitectureTask {
  taskId: string;
  specId: string;
  source: string;
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  targetBranch: string;
  artifactRoot: string;
  contextBundleRef: string;
  priority: number;
  attempt: number;
  limits: ArchitectureTaskLimits;
  policy: ArchitectureTaskPolicy;
  status: ArchitectureTaskStatus;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  provider?: string;
  model?: string;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  blockedReason?: string;
  failedReason?: string;
}

export interface ArchitectureUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ArchitectureRun {
  runId: string;
  taskId: string;
  provider: string;
  model: string;
  status: ArchitectureRunStatus;
  startedAt: string;
  finishedAt?: string;
  traceId?: string;
  usage: ArchitectureUsage;
  result?: ArchitectureResult;
  summary?: string;
  selectedFiles: string[];
  metadata?: Record<string, unknown>;
}

export interface ArchitectureArtifact {
  runId: string;
  taskId: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  commitSha: string;
  filesChanged: string[];
  artifactRoot: string;
  summaryMd: string;
  payload: ArchitectureArtifactPayload;
  selectedFiles: string[];
  metadata?: Record<string, unknown>;
}

export interface ArchitectureTaskRequest {
  specId: string;
  source: string;
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  targetBranch: string;
  artifactRoot: string;
  contextBundleRef: string;
  priority: number;
  limits: ArchitectureTaskLimits;
  policy: ArchitectureTaskPolicy;
}

export interface ImplementationTaskLimits {
  maxTurns: number;
  maxDurationMs: number;
  maxCostUsd: number;
  maxFilesChanged: number;
}

export interface ImplementationTaskPolicy {
  allowAutoMerge: boolean;
  allowShell: boolean;
  allowNetwork: boolean;
  blockedPaths: string[];
}

export interface ImplementationDiscoveryBudget {
  maxFiles: number;
  maxBytes: number;
}

export interface ImplementationDiscoveryUsage {
  files: number;
  bytes: number;
}

export interface ImplementationDiscoveryTrace {
  searchedFiles: string[];
  readFiles: string[];
  selectedContextFiles: string[];
  selectionReasons: Record<string, string>;
  blockedCategory?: string;
  blockedReason?: string;
  budgetUsed: ImplementationDiscoveryUsage;
}

export type ImplementationTaskStatus =
  | "queued"
  | "running"
  | "merge_ready"
  | "blocked"
  | "failed"
  | "merged"
  | "aborted";

export type ImplementationRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "canceled";

export type ImplementationResult = "blocked" | "failed" | "pr_opened" | "merged" | "merge_ready";

export interface ImplementationTask {
  taskId: string;
  specId: string;
  source: string;
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  targetBranch: string;
  allowedPaths: string[];
  verificationTargets: string[];
  contextBundleRef: string;
  attempt: number;
  priority: number;
  limits: ImplementationTaskLimits;
  policy: ImplementationTaskPolicy;
  status: ImplementationTaskStatus;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  provider?: string;
  model?: string;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  blockedReason?: string;
  failedReason?: string;
  planId?: string;
  sliceId?: string;
  sliceIndex?: number;
  totalSlices?: number;
}

export interface ImplementationUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ImplementationPlanSlice {
  sliceId: string;
  title: string;
  goal: string;
  targetFiles: string[];
  expectedTests: string[];
  expectedEvidence: string[];
  writeScope: string[];
  dependsOnSliceIds: string[];
}

export interface ImplementationPlanningRun {
  runId: string;
  taskId: string;
  provider: string;
  model: string;
  status: ImplementationRunStatus;
  startedAt: string;
  finishedAt?: string;
  traceId?: string;
  usage: ImplementationUsage;
  result?: "blocked" | "failed" | "planned";
  summary?: string;
  discovery?: ImplementationDiscoveryTrace;
  metadata?: Record<string, unknown>;
}

export interface ImplementationPlanArtifact {
  runId: string;
  taskId: string;
  planId: string;
  specId: string;
  summary: string;
  targetFiles: string[];
  testFiles: string[];
  evidenceTargets: string[];
  slices: ImplementationPlanSlice[];
  risks: string[];
  blockedReason?: string;
  selectedContextFiles: string[];
  metadata?: Record<string, unknown>;
}

export interface ImplementationRun {
  runId: string;
  taskId: string;
  provider: string;
  model: string;
  status: ImplementationRunStatus;
  startedAt: string;
  finishedAt?: string;
  traceId?: string;
  usage: ImplementationUsage;
  result?: ImplementationResult;
  summary?: string;
  discovery?: ImplementationDiscoveryTrace;
  metadata?: Record<string, unknown>;
}

export interface ImplementationArtifact {
  runId: string;
  taskId: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  commitSha: string;
  filesChanged: string[];
  testSummary: {
    passed: number;
    failed: number;
    command?: string;
  };
  evidenceRefs: string[];
  summaryMd: string;
  sliceId?: string;
  discovery?: ImplementationDiscoveryTrace;
  metadata?: Record<string, unknown>;
}

export interface ImplementationTaskRequest {
  specId: string;
  source: string;
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  targetBranch: string;
  allowedPaths: string[];
  verificationTargets: string[];
  contextBundleRef: string;
  priority: number;
  limits: ImplementationTaskLimits;
  policy: ImplementationTaskPolicy;
  planId?: string;
  sliceId?: string;
  sliceIndex?: number;
  totalSlices?: number;
}

export interface ArchitectureTaskListResponse {
  tasks: ArchitectureTask[];
}

export interface ArchitectureRunResponse {
  run: ArchitectureRun;
  artifact?: ArchitectureArtifact | null;
}

export interface ImplementationTaskListResponse {
  tasks: ImplementationTask[];
}

export interface ImplementationRunResponse {
  run: ImplementationRun;
  artifact?: ImplementationArtifact | null;
}

export const FACTORY_CONTRACT_VERSION = "v1";

export * from "./event-analysis.js";
export * from "./factory-api-client.js";
