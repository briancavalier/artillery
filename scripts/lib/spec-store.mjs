import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const PIPELINE_ORDER = [
  "Draft",
  "Critiqued",
  "Refined",
  "Approved",
  "Implemented",
  "Verified",
  "Deployed"
];

export const SPEC_DIR = process.env.SPEC_DIR ?? join(process.cwd(), "specs");
export const LEDGER_PATH = process.env.LEDGER_PATH ?? join(process.cwd(), "var/ledger/events.ndjson");
export const DRY_RUN = process.env.DRY_RUN === "1";

export async function listSpecPaths() {
  await mkdir(SPEC_DIR, { recursive: true });
  const entries = await readdir(SPEC_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(SPEC_DIR, entry.name));
}

export async function readAllSpecs() {
  const paths = await listSpecPaths();
  const specs = [];

  for (const path of paths) {
    const raw = await readFile(path, "utf8");
    specs.push({ path, data: JSON.parse(raw) });
  }

  return specs;
}

export async function readSpecById(specId) {
  const specs = await readAllSpecs();
  return specs.find((spec) => spec.data.specId === specId) ?? null;
}

export async function writeSpec(path, spec) {
  if (DRY_RUN) {
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
}

export async function appendLedgerEvent(event) {
  const payload = {
    id: randomUUID(),
    at: new Date().toISOString(),
    metadata: {},
    ...event
  };

  if (DRY_RUN) {
    return payload;
  }

  await mkdir(dirname(LEDGER_PATH), { recursive: true });
  await writeFile(LEDGER_PATH, `${JSON.stringify(payload)}\n`, { encoding: "utf8", flag: "a" });
  return payload;
}

export function validateSpec(spec) {
  const issues = [];

  const requiredStringFields = ["specId", "title", "source", "owner", "status", "decision", "intent", "riskNotes"];
  for (const field of requiredStringFields) {
    if (typeof spec[field] !== "string" || spec[field].trim() === "") {
      issues.push(`Missing required string field: ${field}`);
    }
  }

  if (!Array.isArray(spec.scenarios) || spec.scenarios.length === 0) {
    issues.push("scenarios must be a non-empty array");
  }

  if (!Array.isArray(spec.verification) || spec.verification.length === 0) {
    issues.push("verification must be a non-empty array");
  }

  if (!PIPELINE_ORDER.includes(spec.status)) {
    issues.push(`status must be one of: ${PIPELINE_ORDER.join(", ")}`);
  }

  if (!["pending", "accept", "veto", "rollback"].includes(spec.decision)) {
    issues.push("decision must be one of: pending, accept, veto, rollback");
  }

  if (!["human", "agent"].includes(spec.source)) {
    issues.push("source must be one of: human, agent");
  }

  if (Array.isArray(spec.scenarios)) {
    for (const scenario of spec.scenarios) {
      if (typeof scenario.id !== "string" || !scenario.id.startsWith("SCN-")) {
        issues.push("each scenario.id must be a string beginning with SCN-");
      }
      if (typeof scenario.description !== "string" || scenario.description.trim() === "") {
        issues.push(`scenario ${scenario.id ?? "(unknown)"} needs a description`);
      }
      if (typeof scenario.required !== "boolean") {
        issues.push(`scenario ${scenario.id ?? "(unknown)"} must define required boolean`);
      }
    }
  }

  if (Array.isArray(spec.verification)) {
    for (const rule of spec.verification) {
      if (typeof rule.scenarioId !== "string") {
        issues.push("verification rule missing scenarioId");
      }
      if (!Array.isArray(rule.checks) || rule.checks.length === 0) {
        issues.push(`verification for ${rule.scenarioId ?? "(unknown)"} must include checks`);
      }
    }
  }

  const scenarioIds = new Set((spec.scenarios ?? []).map((scenario) => scenario.id));
  const requiredScenarioIds = (spec.scenarios ?? []).filter((scenario) => scenario.required).map((scenario) => scenario.id);

  for (const requiredScenarioId of requiredScenarioIds) {
    const hasRule = (spec.verification ?? []).some((rule) => rule.scenarioId === requiredScenarioId);
    if (!hasRule) {
      issues.push(`required scenario ${requiredScenarioId} is missing verification mapping`);
    }
  }

  for (const rule of spec.verification ?? []) {
    if (!scenarioIds.has(rule.scenarioId)) {
      issues.push(`verification references unknown scenario: ${rule.scenarioId}`);
    }
  }

  return issues;
}

export function canTransition(currentStatus, targetStatus) {
  const currentIndex = PIPELINE_ORDER.indexOf(currentStatus);
  const targetIndex = PIPELINE_ORDER.indexOf(targetStatus);
  return currentIndex >= 0 && targetIndex >= 0 && targetIndex >= currentIndex;
}
