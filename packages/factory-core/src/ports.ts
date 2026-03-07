import type { CloudEventEnvelope, FeatureSpec } from "@darkfactory/contracts";

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
  readCanarySnapshot(): Promise<CanarySnapshot | null>;
  deploy(environment: "staging" | "production", specId: string): Promise<DeploymentRecord>;
  rollback(specId: string, reason: string): Promise<void>;
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
