import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DRY_RUN,
  appendLedgerEvent,
  canTransition,
  readAllSpecs,
  readSpecById,
  validateSpec,
  writeSpec
} from "./lib/spec-store.mjs";

const command = process.argv[2];
const targetSpecId = process.env.SPEC_ID ?? process.argv[3];
const reason = process.env.REASON ?? process.argv[4] ?? "";

if (!command) {
  usage();
  process.exitCode = 1;
} else {
  await run(command).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function run(step) {
  switch (step) {
    case "critic":
      await critic();
      return;
    case "evaluate":
      await evaluate();
      return;
    case "refine":
      await refine();
      return;
    case "accept":
      await accept();
      return;
    case "veto":
      await veto();
      return;
    case "implement":
      await implement();
      return;
    case "verify":
      await verify();
      return;
    case "deploy":
      await deploy();
      return;
    case "rollback":
      await rollback();
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

async function critic() {
  const specs = await selectSpecs(["Draft", "Critiqued", "Refined"]);

  for (const spec of specs) {
    const issues = [...validateSpec(spec.data), ...criticChecks(spec.data)];

    if (issues.length === 0 && canTransition(spec.data.status, "Critiqued")) {
      spec.data.status = "Critiqued";
      spec.data.updatedAt = new Date().toISOString();
      await writeSpec(spec.path, spec.data);
      await appendLedgerEvent({
        type: "pipeline_event",
        action: "spec_critiqued",
        actor: "spec_critic_agent",
        specId: spec.data.specId,
        metadata: { passed: true, dryRun: DRY_RUN }
      });
      console.log(`[critic] PASS ${spec.data.specId}`);
    } else {
      await appendLedgerEvent({
        type: "pipeline_event",
        action: "gate_failed",
        actor: "spec_critic_agent",
        specId: spec.data.specId,
        metadata: { gate: "critic", issues, dryRun: DRY_RUN }
      });
      console.log(`[critic] FAIL ${spec.data.specId}`);
      for (const issue of issues) {
        console.log(`  - ${issue}`);
      }
    }
  }
}

async function evaluate() {
  const specs = await selectSpecs(["Critiqued", "Refined", "Approved"]);
  await mkdir(join(process.cwd(), "reports/evaluations"), { recursive: true });

  for (const spec of specs) {
    const issues = [...validateSpec(spec.data), ...criticChecks(spec.data)];
    const blockers = issues.filter((issue) => issue.toLowerCase().includes("missing") || issue.toLowerCase().includes("must"));
    const score = Math.max(0, 100 - issues.length * 12 - blockers.length * 8);
    const report = {
      specId: spec.data.specId,
      score,
      blockers,
      issues,
      at: new Date().toISOString()
    };

    const reportPath = join(process.cwd(), "reports/evaluations", `${spec.data.specId}.json`);
    if (!DRY_RUN) {
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }

    await appendLedgerEvent({
      type: "pipeline_event",
      action: "spec_evaluated",
      actor: "spec_evaluator_agent",
      specId: spec.data.specId,
      metadata: { score, blockers: blockers.length, dryRun: DRY_RUN }
    });

    console.log(`[evaluate] ${spec.data.specId} score=${score} blockers=${blockers.length}`);
  }
}

async function refine() {
  const specs = await selectSpecs(["Critiqued"]);

  for (const spec of specs) {
    const reportPath = join(process.cwd(), "reports/evaluations", `${spec.data.specId}.json`);
    const report = await safeReadJson(reportPath);
    const blockers = Array.isArray(report?.blockers) ? report.blockers : ["evaluation report missing"];

    if (blockers.length > 0) {
      await appendLedgerEvent({
        type: "pipeline_event",
        action: "gate_failed",
        actor: "refinement_agent",
        specId: spec.data.specId,
        metadata: { gate: "refine", blockers, dryRun: DRY_RUN }
      });
      console.log(`[refine] BLOCKED ${spec.data.specId}`);
      continue;
    }

    if (canTransition(spec.data.status, "Refined")) {
      spec.data.status = "Refined";
      spec.data.updatedAt = new Date().toISOString();
      await writeSpec(spec.path, spec.data);
    }

    await appendLedgerEvent({
      type: "pipeline_event",
      action: "spec_refined",
      actor: "refinement_agent",
      specId: spec.data.specId,
      metadata: { dryRun: DRY_RUN }
    });

    console.log(`[refine] PASS ${spec.data.specId}`);
  }
}

async function accept() {
  const spec = await requireSingleSpec("accept");
  if (!["Critiqued", "Refined", "Approved"].includes(spec.data.status)) {
    throw new Error(`accept requires status Critiqued/Refined/Approved. Current: ${spec.data.status}`);
  }

  spec.data.decision = "accept";
  spec.data.status = "Approved";
  spec.data.updatedAt = new Date().toISOString();
  await writeSpec(spec.path, spec.data);

  await appendLedgerEvent({
    type: "pipeline_event",
    action: "spec_accepted",
    actor: "maintainer",
    specId: spec.data.specId,
    metadata: { dryRun: DRY_RUN }
  });

  console.log(`[accept] ${spec.data.specId} approved`);
}

async function veto() {
  const spec = await requireSingleSpec("veto");
  if (!reason.trim()) {
    throw new Error("veto requires REASON env var or reason argument");
  }

  spec.data.decision = "veto";
  spec.data.updatedAt = new Date().toISOString();
  await writeSpec(spec.path, spec.data);

  await appendLedgerEvent({
    type: "pipeline_event",
    action: "spec_vetoed",
    actor: "maintainer",
    specId: spec.data.specId,
    metadata: { reason, dryRun: DRY_RUN }
  });

  console.log(`[veto] ${spec.data.specId} vetoed (${reason})`);
}

async function implement() {
  const specs = await selectSpecs(["Approved"]);
  for (const spec of specs) {
    if (spec.data.decision !== "accept") {
      continue;
    }

    spec.data.status = "Implemented";
    spec.data.updatedAt = new Date().toISOString();
    await writeSpec(spec.path, spec.data);

    await appendLedgerEvent({
      type: "pipeline_event",
      action: "spec_implemented",
      actor: "builder_agent",
      specId: spec.data.specId,
      metadata: { dryRun: DRY_RUN }
    });

    console.log(`[implement] ${spec.data.specId}`);
  }
}

async function verify() {
  const specs = await selectSpecs(["Implemented", "Verified"]);

  for (const spec of specs) {
    const requiredScenarios = spec.data.scenarios.filter((scenario) => scenario.required).map((scenario) => scenario.id);
    const missing = [];

    for (const scenarioId of requiredScenarios) {
      const evidencePath = join(process.cwd(), "evidence", spec.data.specId, `${scenarioId}.json`);
      const evidence = await safeReadJson(evidencePath);
      if (!evidence || evidence.passed !== true) {
        missing.push(scenarioId);
      }
    }

    if (missing.length > 0) {
      await appendLedgerEvent({
        type: "pipeline_event",
        action: "gate_failed",
        actor: "verifier_agent",
        specId: spec.data.specId,
        metadata: { gate: "verify", missingScenarioEvidence: missing, dryRun: DRY_RUN }
      });
      console.log(`[verify] FAIL ${spec.data.specId} missing=${missing.join(",")}`);
      continue;
    }

    spec.data.status = "Verified";
    spec.data.updatedAt = new Date().toISOString();
    await writeSpec(spec.path, spec.data);

    await appendLedgerEvent({
      type: "pipeline_event",
      action: "spec_verified",
      actor: "verifier_agent",
      specId: spec.data.specId,
      metadata: { requiredScenarios: requiredScenarios.length, dryRun: DRY_RUN }
    });

    console.log(`[verify] PASS ${spec.data.specId}`);
  }
}

async function deploy() {
  const specs = await selectSpecs(["Verified"]);
  const canary = (await safeReadJson(join(process.cwd(), "ops/canary/latest.json"))) ?? { pass: true, metrics: {} };

  for (const spec of specs) {
    if (canary.pass !== true) {
      await appendLedgerEvent({
        type: "pipeline_event",
        action: "gate_failed",
        actor: "deployer_agent",
        specId: spec.data.specId,
        metadata: { gate: "canary", metrics: canary.metrics, dryRun: DRY_RUN }
      });
      await doRollback(spec.data.specId, `Canary failed: ${JSON.stringify(canary.metrics)}`);
      console.log(`[deploy] FAIL ${spec.data.specId} canary`);
      continue;
    }

    spec.data.status = "Deployed";
    spec.data.updatedAt = new Date().toISOString();
    await writeSpec(spec.path, spec.data);

    await appendLedgerEvent({
      type: "pipeline_event",
      action: "spec_deployed",
      actor: "deployer_agent",
      specId: spec.data.specId,
      metadata: { metrics: canary.metrics, dryRun: DRY_RUN }
    });

    console.log(`[deploy] PASS ${spec.data.specId}`);
  }
}

async function rollback() {
  const spec = await requireSingleSpec("rollback");
  if (!reason.trim()) {
    throw new Error("rollback requires REASON env var or reason argument");
  }
  await doRollback(spec.data.specId, reason);
  console.log(`[rollback] ${spec.data.specId} -> Refined (${reason})`);
}

async function doRollback(specId, rollbackReason) {
  const spec = await readSpecById(specId);
  if (!spec) {
    throw new Error(`Spec not found: ${specId}`);
  }

  spec.data.decision = "rollback";
  spec.data.status = "Refined";
  spec.data.updatedAt = new Date().toISOString();
  await writeSpec(spec.path, spec.data);

  await appendLedgerEvent({
    type: "pipeline_event",
    action: "spec_rollback",
    actor: "maintainer",
    specId,
    metadata: { reason: rollbackReason, dryRun: DRY_RUN }
  });

  await appendLedgerEvent({
    type: "incident",
    action: "rollback_triggered",
    actor: "deployer_agent",
    specId,
    metadata: { reason: rollbackReason, dryRun: DRY_RUN }
  });
}

function criticChecks(spec) {
  const issues = [];

  if (spec.intent.length < 40) {
    issues.push("intent should be at least 40 characters to remain actionable");
  }

  if (spec.riskNotes.length < 20) {
    issues.push("riskNotes should include at least one concrete risk and mitigation");
  }

  if (spec.scenarios.length < 2) {
    issues.push("at least two scenarios are required for scenario-based verification");
  }

  const uniqueScenarioIds = new Set(spec.scenarios.map((scenario) => scenario.id));
  if (uniqueScenarioIds.size !== spec.scenarios.length) {
    issues.push("scenario ids must be unique");
  }

  return issues;
}

async function selectSpecs(statuses) {
  const specs = await readAllSpecs();
  const byStatus = specs.filter((spec) => statuses.includes(spec.data.status));

  if (targetSpecId) {
    return byStatus.filter((spec) => spec.data.specId === targetSpecId);
  }

  return byStatus;
}

async function requireSingleSpec(action) {
  if (!targetSpecId) {
    throw new Error(`${action} requires SPEC_ID env var or spec id argument`);
  }

  const spec = await readSpecById(targetSpecId);
  if (!spec) {
    throw new Error(`Spec not found: ${targetSpecId}`);
  }

  return spec;
}

async function safeReadJson(path) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function usage() {
  console.log("Usage: node scripts/factory.mjs <critic|evaluate|refine|accept|veto|implement|verify|deploy|rollback> [SPEC_ID]");
}
