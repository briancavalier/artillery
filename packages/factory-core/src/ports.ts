import type {
  CloudEventEnvelope,
  FeatureSpec,
  ImplementationArtifact,
  ImplementationRun,
  ImplementationTask,
  ImplementationTaskRequest
} from "@darkfactory/contracts";

export interface EvaluationReport {
  specId: string;
  score: number;
  blockers: string[];
  issues: string[];
  at: string;
}

export interface ScenarioEvidence {
  scenarioId: string;
  passed: boolean;
  at: string;
  artifact?: string;
}

export interface EvidenceGenerationOptions {
  actor?: string;
  source?: string;
  deployId?: string;
}

export interface ImplementationScope {
  allowedPaths: string[];
  blockedPaths: string[];
  maxFilesChanged?: number;
}

export interface ImplementationContext {
  specId: string;
  relevantFiles: string[];
  allowedPaths: string[];
  blockedPaths: string[];
  recommendedCommands: string[];
  evidenceCapabilities: string[];
  reviewNotes: string[];
  maxFilesChanged?: number;
}

export interface CanarySnapshot {
  generatedAt: string;
  pass: boolean;
  metrics: Record<string, unknown>;
}

export interface DeploymentRecord {
  environment: "staging" | "production";
  status: "ok" | "failed";
  deployId: string;
  metadata: Record<string, unknown>;
}

export interface SpecRecord {
  path: string;
  data: FeatureSpec;
}

export interface FactoryAdapter {
  listSpecs(): Promise<SpecRecord[]>;
  readSpecById(specId: string): Promise<SpecRecord | null>;
  writeSpec(record: SpecRecord): Promise<void>;
  appendEvent(event: CloudEventEnvelope<Record<string, unknown>>): Promise<void>;
  writeEvaluation(report: EvaluationReport): Promise<void>;
  readEvaluation(specId: string): Promise<EvaluationReport | null>;
  readScenarioEvidence(specId: string, scenarioId: string): Promise<ScenarioEvidence | null>;
  generateScenarioEvidence?(specId: string, options?: EvidenceGenerationOptions): Promise<ScenarioEvidence[]>;
  buildImplementationContext?(specId: string): Promise<ImplementationContext>;
  getImplementationScope?(specId: string): Promise<ImplementationScope>;
  readCanarySnapshot(): Promise<CanarySnapshot | null>;
  deploy(environment: "staging" | "production", specId: string): Promise<DeploymentRecord>;
  rollback(specId: string, reason: string): Promise<void>;
}

export interface ImplementationProvider {
  startTask(task: ImplementationTask): Promise<ImplementationRun>;
  getRun(runId: string): Promise<ImplementationRun | null>;
  cancelRun(runId: string): Promise<void>;
  collectArtifacts(runId: string): Promise<ImplementationArtifact | null>;
}

export interface FactoryStorePort {
  enqueueImplementationTask(payload: ImplementationTaskRequest): Promise<ImplementationTask>;
  listImplementationTasks(): Promise<ImplementationTask[]>;
  getImplementationTask(taskId: string): Promise<ImplementationTask | null>;
  findImplementationTaskBySpecId(specId: string): Promise<ImplementationTask | null>;
  leaseImplementationTask(): Promise<ImplementationTask | null>;
  writeImplementationTask(task: ImplementationTask): Promise<void>;
  writeImplementationRun(run: ImplementationRun): Promise<void>;
  getImplementationRun(runId: string): Promise<ImplementationRun | null>;
  writeImplementationArtifact(artifact: ImplementationArtifact): Promise<void>;
  getImplementationArtifact(runId: string): Promise<ImplementationArtifact | null>;
}

export interface RunOptions {
  step: PipelineStep;
  specId?: string;
  reason?: string;
  deployMode?: "promote" | "staging-only" | "production-only";
  dryRun?: boolean;
  actor?: string;
  source?: string;
  deployId?: string;
}

export type PipelineStep =
  | "critic"
  | "evaluate"
  | "refine"
  | "accept"
  | "veto"
  | "implement"
  | "verify"
  | "deploy"
  | "rollback";
