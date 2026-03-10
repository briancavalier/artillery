import { randomUUID } from "node:crypto";
import type { CloudEventEnvelope, FeatureSpec, SpecStatus } from "@darkfactory/contracts";
import type {
  CanarySnapshot,
  EvaluationReport,
  FactoryAdapter,
  PipelineStep,
  RunOptions,
  SpecRecord
} from "./ports.js";

const PIPELINE_ORDER: SpecStatus[] = [
  "Draft",
  "Critiqued",
  "Refined",
  "Approved",
  "Architected",
  "Implemented",
  "Verified",
  "Deployed"
];

export async function runPipelineStep(adapter: FactoryAdapter, options: RunOptions): Promise<void> {
  const step = options.step;

  switch (step) {
    case "critic":
      await critic(adapter, options);
      return;
    case "evaluate":
      await evaluate(adapter, options);
      return;
    case "refine":
      await refine(adapter, options);
      return;
    case "accept":
      await accept(adapter, options);
      return;
    case "architect":
      await architect(adapter, options);
      return;
    case "veto":
      await veto(adapter, options);
      return;
    case "architect":
      await architect(adapter, options);
      return;
    case "implement":
      await implement(adapter, options);
      return;
    case "verify":
      await verify(adapter, options);
      return;
    case "deploy":
      await deploy(adapter, options);
      return;
    case "rollback":
      await rollback(adapter, options);
      return;
  }
}

export function validateSpec(spec: FeatureSpec): string[] {
  const issues: string[] = [];

  const requiredStrings: Array<keyof FeatureSpec> = [
    "specId",
    "title",
    "source",
    "owner",
    "status",
    "decision",
    "intent",
    "riskNotes",
    "createdAt",
    "updatedAt"
  ];

  for (const field of requiredStrings) {
    const value = spec[field];
    if (typeof value !== "string" || value.trim() === "") {
      issues.push(`Missing required string field: ${field}`);
    }
  }

  if (!PIPELINE_ORDER.includes(spec.status)) {
    issues.push(`status must be one of: ${PIPELINE_ORDER.join(", ")}`);
  }

  if (!["human", "agent"].includes(spec.source)) {
    issues.push("source must be one of: human, agent");
  }

  if (!["pending", "accept", "veto", "rollback"].includes(spec.decision)) {
    issues.push("decision must be one of: pending, accept, veto, rollback");
  }

  if (!Array.isArray(spec.scenarios) || spec.scenarios.length === 0) {
    issues.push("scenarios must be a non-empty array");
  }

  if (!Array.isArray(spec.verification) || spec.verification.length === 0) {
    issues.push("verification must be a non-empty array");
  }

  for (const scenario of spec.scenarios ?? []) {
    if (typeof scenario.id !== "string" || !scenario.id.startsWith("SCN-")) {
      issues.push("each scenario.id must begin with SCN-");
    }
    if (typeof scenario.description !== "string" || scenario.description.trim() === "") {
      issues.push(`scenario ${scenario.id ?? "unknown"} needs a description`);
    }
    if (typeof scenario.required !== "boolean") {
      issues.push(`scenario ${scenario.id ?? "unknown"} must define required boolean`);
    }
  }

  const scenarioIds = new Set((spec.scenarios ?? []).map((scenario) => scenario.id));
  for (const mapping of spec.verification ?? []) {
    if (!scenarioIds.has(mapping.scenarioId)) {
      issues.push(`verification references unknown scenario: ${mapping.scenarioId}`);
    }
    if (!Array.isArray(mapping.checks) || mapping.checks.length === 0) {
      issues.push(`verification for ${mapping.scenarioId} must include checks`);
    }
  }

  const requiredScenarioIds = (spec.scenarios ?? [])
    .filter((scenario) => scenario.required)
    .map((scenario) => scenario.id);
  for (const scenarioId of requiredScenarioIds) {
    const mapped = (spec.verification ?? []).some((entry) => entry.scenarioId === scenarioId);
    if (!mapped) {
      issues.push(`required scenario ${scenarioId} is missing verification mapping`);
    }
  }

  return issues;
}

export function criticChecks(spec: FeatureSpec): string[] {
  const issues: string[] = [];

  if (spec.intent.length < 40) {
    issues.push("intent should be at least 40 characters");
  }
  if (spec.riskNotes.length < 20) {
    issues.push("riskNotes should include one concrete risk and mitigation");
  }
  if (spec.scenarios.length < 2) {
    issues.push("at least two scenarios are required");
  }

  const uniqueIds = new Set(spec.scenarios.map((scenario) => scenario.id));
  if (uniqueIds.size !== spec.scenarios.length) {
    issues.push("scenario ids must be unique");
  }

  return issues;
}

async function critic(adapter: FactoryAdapter, options: RunOptions): Promise<void> {
  const specs = await selectSpecs(adapter, ["Draft", "Critiqued", "Refined"], options.specId);
  for (const record of specs) {
    const issues = [...validateSpec(record.data), ...criticChecks(record.data)];
    if (issues.length === 0) {
      await updateStatus(adapter, record, "Critiqued");
      await emit(adapter, options, "pipeline_event", "spec_critiqued", {
        specId: record.data.specId,
        scenarioId: firstScenario(record.data),
        passed: true
      });
    } else {
      await emit(adapter, options, "pipeline_event", "gate_failed", {
        specId: record.data.specId,
        scenarioId: firstScenario(record.data),
        gate: "critic",
        issues
      });
    }
  }
}

async function evaluate(adapter: FactoryAdapter, options: RunOptions): Promise<void> {
  const specs = await selectSpecs(adapter, ["Critiqued", "Refined", "Approved"], options.specId);

  for (const record of specs) {
    const issues = [...validateSpec(record.data), ...criticChecks(record.data)];
    const blockers = issues.filter((issue) => /missing|must|required/i.test(issue));
    const score = Math.max(0, 100 - issues.length * 12 - blockers.length * 8);

    const report: EvaluationReport = {
      specId: record.data.specId,
      score,
      blockers,
      issues,
      at: new Date().toISOString()
    };

    await adapter.writeEvaluation(report);
    await emit(adapter, options, "pipeline_event", "spec_evaluated", {
      specId: record.data.specId,
      scenarioId: firstScenario(record.data),
      blockers: blockers.length,
      score
    });
  }
}

async function refine(adapter: FactoryAdapter, options: RunOptions): Promise<void> {
  const specs = await selectSpecs(adapter, ["Critiqued"], options.specId);
  for (const record of specs) {
    const report = await adapter.readEvaluation(record.data.specId);
    const blockers = report?.blockers ?? ["evaluation report missing"];

    if (blockers.length > 0) {
      await emit(adapter, options, "pipeline_event", "gate_failed", {
        specId: record.data.specId,
        scenarioId: firstScenario(record.data),
        gate: "refine",
        blockers
      });
      continue;
    }

    await updateStatus(adapter, record, "Refined");
    await emit(adapter, options, "pipeline_event", "spec_refined", {
      specId: record.data.specId,
      scenarioId: firstScenario(record.data)
    });
  }
}

async function accept(adapter: FactoryAdapter, options: RunOptions): Promise<void> {
  const record = await requireSpec(adapter, options.specId, "accept");

  if (!["Critiqued", "Refined", "Approved"].includes(record.data.status)) {
    throw new Error(`accept requires status Critiqued/Refined/Approved. Current: ${record.data.status}`);
  }

  record.data.decision = "accept";
  await updateStatus(adapter, record, "Approved");
  await emit(adapter, options, "pipeline_event", "spec_accepted", {
    specId: record.data.specId,
    scenarioId: firstScenario(record.data)
  });
}

async function veto(adapter: FactoryAdapter, options: RunOptions): Promise<void> {
  const record = await requireSpec(adapter, options.specId, "veto");
  if (!options.reason?.trim()) {
    throw new Error("veto requires reason");
  }

  record.data.decision = "veto";
  record.data.updatedAt = new Date().toISOString();
  await adapter.writeSpec(record);

  await emit(adapter, options, "pipeline_event", "spec_vetoed", {
    specId: record.data.specId,
    scenarioId: firstScenario(record.data),
    reason: options.reason
  });
}

async function architect(adapter: FactoryAdapter, options: RunOptions): Promise<void> {
  const specs = await selectSpecs(adapter, ["Approved", "Architected"], options.specId);
  for (const record of specs) {
    if (record.data.decision !== "accept") {
      continue;
    }

    await updateStatus(adapter, record, "Architected");
    await emit(adapter, options, "pipeline_event", "spec_architected", {
      specId: record.data.specId,
      scenarioId: firstScenario(record.data)
    });
  }
}

async function implement(adapter: FactoryAdapter, options: RunOptions): Promise<void> {
  const specs = await selectSpecs(adapter, ["Architected"], options.specId);
  for (const record of specs) {
    if (record.data.decision !== "accept") {
      continue;
    }

    await updateStatus(adapter, record, "Implemented");
    await emit(adapter, options, "pipeline_event", "spec_implemented", {
      specId: record.data.specId,
      scenarioId: firstScenario(record.data)
    });
  }
}

async function verify(adapter: FactoryAdapter, options: RunOptions): Promise<void> {
  const specs = await selectSpecs(adapter, ["Implemented", "Verified"], options.specId);

  for (const record of specs) {
    const requiredScenarios = record.data.scenarios.filter((scenario) => scenario.required).map((scenario) => scenario.id);
    const missing: string[] = [];

    for (const scenarioId of requiredScenarios) {
      const evidence = await adapter.readScenarioEvidence(record.data.specId, scenarioId);
      if (!evidence || evidence.passed !== true) {
        missing.push(scenarioId);
      }
    }

    if (missing.length > 0) {
      await emit(adapter, options, "pipeline_event", "gate_failed", {
        specId: record.data.specId,
        scenarioId: missing[0] ?? firstScenario(record.data),
        gate: "verify",
        missingScenarioEvidence: missing
      });
      continue;
    }

    await updateStatus(adapter, record, "Verified");
    await emit(adapter, options, "pipeline_event", "spec_verified", {
      specId: record.data.specId,
      scenarioId: firstScenario(record.data),
      requiredScenarios: requiredScenarios.length
    });
  }
}

async function deploy(adapter: FactoryAdapter, options: RunOptions): Promise<void> {
  const specs = await selectSpecs(adapter, ["Verified"], options.specId);
  const canary = (await adapter.readCanarySnapshot()) ?? defaultCanary();
  const mode = options.deployMode ?? "promote";

  for (const record of specs) {
    if (canary.pass !== true) {
      await emit(adapter, options, "pipeline_event", "gate_failed", {
        specId: record.data.specId,
        scenarioId: firstScenario(record.data),
        gate: "canary",
        metrics: canary.metrics
      });
      await doRollback(adapter, options, record.data.specId, `Canary failed: ${JSON.stringify(canary.metrics)}`);
      continue;
    }

    if (mode !== "production-only") {
      const staging = await adapter.deploy("staging", record.data.specId);
      if (staging.status !== "ok") {
        await doRollback(adapter, options, record.data.specId, "Staging deploy failed");
        continue;
      }

      await emit(adapter, options, "pipeline_event", "spec_deployed_staging", {
        specId: record.data.specId,
        scenarioId: firstScenario(record.data),
        environment: "staging",
        metrics: canary.metrics
      });

      if (mode === "staging-only") {
        continue;
      }
    }

    const production = await adapter.deploy("production", record.data.specId);
    if (production.status !== "ok") {
      await doRollback(adapter, options, record.data.specId, "Production deploy failed");
      continue;
    }

    await updateStatus(adapter, record, "Deployed");
    await emit(adapter, options, "pipeline_event", "spec_deployed", {
      specId: record.data.specId,
      scenarioId: firstScenario(record.data),
      environment: "production",
      metrics: canary.metrics
    });
  }
}

async function rollback(adapter: FactoryAdapter, options: RunOptions): Promise<void> {
  const record = await requireSpec(adapter, options.specId, "rollback");
  if (!options.reason?.trim()) {
    throw new Error("rollback requires reason");
  }
  await doRollback(adapter, options, record.data.specId, options.reason);
}

async function doRollback(adapter: FactoryAdapter, options: RunOptions, specId: string, reason: string): Promise<void> {
  const record = await adapter.readSpecById(specId);
  if (!record) {
    throw new Error(`Spec not found: ${specId}`);
  }

  record.data.decision = "rollback";
  // Rollback is a controlled downgrade and must bypass forward-only transition checks.
  record.data.status = "Refined";
  record.data.updatedAt = new Date().toISOString();
  await adapter.writeSpec(record);
  await adapter.rollback(specId, reason);

  await emit(adapter, options, "pipeline_event", "spec_rollback", {
    specId,
    scenarioId: firstScenario(record.data),
    reason
  });

  await emit(adapter, options, "incident", "rollback_triggered", {
    specId,
    scenarioId: firstScenario(record.data),
    reason
  });
}

async function selectSpecs(adapter: FactoryAdapter, statuses: SpecStatus[], specId?: string): Promise<SpecRecord[]> {
  const all = await adapter.listSpecs();
  const filtered = all.filter((record) => statuses.includes(record.data.status));
  return specId ? filtered.filter((record) => record.data.specId === specId) : filtered;
}

async function requireSpec(adapter: FactoryAdapter, specId: string | undefined, action: PipelineStep): Promise<SpecRecord> {
  if (!specId) {
    throw new Error(`${action} requires spec id`);
  }

  const record = await adapter.readSpecById(specId);
  if (!record) {
    throw new Error(`Spec not found: ${specId}`);
  }

  return record;
}

function canTransition(currentStatus: SpecStatus, targetStatus: SpecStatus): boolean {
  const currentIndex = PIPELINE_ORDER.indexOf(currentStatus);
  const targetIndex = PIPELINE_ORDER.indexOf(targetStatus);
  return currentIndex >= 0 && targetIndex >= 0 && targetIndex >= currentIndex;
}

async function updateStatus(adapter: FactoryAdapter, record: SpecRecord, targetStatus: SpecStatus): Promise<void> {
  if (!canTransition(record.data.status, targetStatus)) {
    return;
  }

  record.data.status = targetStatus;
  record.data.updatedAt = new Date().toISOString();
  await adapter.writeSpec(record);
}

function defaultCanary(): CanarySnapshot {
  return {
    generatedAt: new Date().toISOString(),
    pass: true,
    metrics: {}
  };
}

function firstScenario(spec: FeatureSpec): string {
  return spec.scenarios[0]?.id ?? "SCN-UNKNOWN";
}

async function emit(
  adapter: FactoryAdapter,
  options: RunOptions,
  type: CloudEventEnvelope["type"],
  action: string,
  details: { specId: string; scenarioId: string; [key: string]: unknown }
): Promise<void> {
  const deployId = options.deployId ?? process.env.DEPLOY_ID ?? "deploy-local";
  const envelope: CloudEventEnvelope<Record<string, unknown>> = {
    specversion: "1.0",
    id: randomUUID(),
    source: options.source ?? "darkfactory.core",
    type,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: {
      action,
      actor: options.actor ?? "factory_runner",
      specId: String(details.specId),
      scenarioId: String(details.scenarioId ?? "SCN-UNKNOWN"),
      deployId,
      matchId: String(details.matchId ?? "match-unbound"),
      metadata: details
    }
  };

  await adapter.appendEvent(envelope);
}
