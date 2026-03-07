import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudEventEnvelope, FeatureSpec } from "@darkfactory/contracts";
import { runPipelineStep, type FactoryAdapter, type SpecRecord, type EvaluationReport, type ScenarioEvidence, type CanarySnapshot, type DeploymentRecord } from "@darkfactory/core";

class InMemoryAdapter implements FactoryAdapter {
  specs = new Map<string, SpecRecord>();
  events: Array<CloudEventEnvelope<Record<string, unknown>>> = [];
  evaluations = new Map<string, EvaluationReport>();
  evidence = new Map<string, ScenarioEvidence>();

  constructor(spec: FeatureSpec) {
    this.specs.set(spec.specId, { path: `/virtual/${spec.specId}.json`, data: structuredClone(spec) });
    this.evidence.set(`${spec.specId}:SCN-2001`, { scenarioId: "SCN-2001", passed: true, at: new Date().toISOString() });
    this.evidence.set(`${spec.specId}:SCN-2002`, { scenarioId: "SCN-2002", passed: true, at: new Date().toISOString() });
  }

  async listSpecs(): Promise<SpecRecord[]> { return [...this.specs.values()]; }
  async readSpecById(specId: string): Promise<SpecRecord | null> { return this.specs.get(specId) ?? null; }
  async writeSpec(record: SpecRecord): Promise<void> { this.specs.set(record.data.specId, structuredClone(record)); }
  async appendEvent(event: CloudEventEnvelope<Record<string, unknown>>): Promise<void> { this.events.push(event); }
  async writeEvaluation(report: EvaluationReport): Promise<void> { this.evaluations.set(report.specId, report); }
  async readEvaluation(specId: string): Promise<EvaluationReport | null> { return this.evaluations.get(specId) ?? null; }
  async readScenarioEvidence(specId: string, scenarioId: string): Promise<ScenarioEvidence | null> {
    return this.evidence.get(`${specId}:${scenarioId}`) ?? null;
  }
  async readCanarySnapshot(): Promise<CanarySnapshot | null> { return { generatedAt: new Date().toISOString(), pass: true, metrics: {} }; }
  async deploy(environment: "staging" | "production", specId: string): Promise<DeploymentRecord> {
    return { environment, status: "ok", deployId: `${environment}-deploy`, metadata: { specId } };
  }
  async rollback(): Promise<void> {}
}

test("factory core pipeline runs against non-artillery in-memory adapter", async () => {
  const spec: FeatureSpec = {
    specId: "SPEC-DUMMY-1",
    title: "Dummy reusable adapter",
    source: "human",
    owner: "@tester",
    status: "Draft",
    decision: "pending",
    intent: "Validate core pipeline behavior with a project-agnostic adapter implementation.",
    scenarios: [
      { id: "SCN-2001", description: "scenario one", required: true },
      { id: "SCN-2002", description: "scenario two", required: true }
    ],
    verification: [
      { scenarioId: "SCN-2001", checks: ["unit"] },
      { scenarioId: "SCN-2002", checks: ["e2e"] }
    ],
    riskNotes: "Risk: regressions. Mitigation: enforce required scenario evidence before deployment.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const adapter = new InMemoryAdapter(spec);

  await runPipelineStep(adapter, { step: "critic", specId: spec.specId });
  await runPipelineStep(adapter, { step: "evaluate", specId: spec.specId });
  await runPipelineStep(adapter, { step: "refine", specId: spec.specId });
  await runPipelineStep(adapter, { step: "accept", specId: spec.specId });
  await runPipelineStep(adapter, { step: "implement", specId: spec.specId });
  await runPipelineStep(adapter, { step: "verify", specId: spec.specId });
  await runPipelineStep(adapter, { step: "deploy", specId: spec.specId, deployMode: "promote" });

  const final = await adapter.readSpecById(spec.specId);
  assert.ok(final);
  assert.equal(final?.data.status, "Deployed");
  assert.ok(adapter.events.some((event) => event.data.action === "spec_deployed"));
});
