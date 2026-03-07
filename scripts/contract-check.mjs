import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const issues = [];

const projectControlPath = join(root, "packages/factory-contracts/openapi/project-control.v1.json");
const factoryAdminPath = join(root, "packages/factory-contracts/openapi/factory-admin.v1.json");
const cloudeventsPath = join(root, "packages/factory-contracts/cloudevents/cloudevents.v1.schema.json");

const projectControl = await readJson(projectControlPath, issues, "project-control");
const factoryAdmin = await readJson(factoryAdminPath, issues, "factory-admin");
const cloudevents = await readJson(cloudeventsPath, issues, "cloudevents aggregate");

if (projectControl) {
  requirePath(projectControl, "/v1/project/health", issues, projectControlPath);
  requirePath(projectControl, "/v1/project/canary", issues, projectControlPath);
  requirePath(projectControl, "/v1/project/scenarios/{scenarioId}/verify", issues, projectControlPath);
  requirePath(projectControl, "/v1/project/rollback", issues, projectControlPath);
  requireVersion(projectControl, "v1", issues, projectControlPath);
}

if (factoryAdmin) {
  requirePath(factoryAdmin, "/v1/admin/factory", issues, factoryAdminPath);
  requirePath(factoryAdmin, "/v1/admin/agents", issues, factoryAdminPath);
  requirePath(factoryAdmin, "/v1/events", issues, factoryAdminPath);
  requireVersion(factoryAdmin, "v1", issues, factoryAdminPath);
}

if (cloudevents) {
  if (!Array.isArray(cloudevents.oneOf) || cloudevents.oneOf.length < 5) {
    issues.push(`${cloudeventsPath}: expected oneOf with at least 5 event schemas`);
  }
}

for (const name of [
  "game_event.v1.schema.json",
  "pipeline_event.v1.schema.json",
  "agent_event.v1.schema.json",
  "user_feedback.v1.schema.json",
  "incident.v1.schema.json"
]) {
  const schemaPath = join(root, "packages/factory-contracts/cloudevents", name);
  const schema = await readJson(schemaPath, issues, name);
  if (!schema) {
    continue;
  }

  const required = schema?.properties?.data?.required;
  if (!Array.isArray(required)) {
    issues.push(`${schemaPath}: data.required must be an array`);
    continue;
  }

  for (const field of ["specId", "scenarioId", "deployId", "matchId", "action", "actor"]) {
    if (!required.includes(field)) {
      issues.push(`${schemaPath}: missing required field data.${field}`);
    }
  }
}

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(`[contracts] ${issue}`);
  }
  process.exitCode = 1;
} else {
  console.log("[contracts] checks passed");
}

async function readJson(path, issues, label) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    issues.push(`unable to parse ${label} at ${path}`);
    return null;
  }
}

function requirePath(openapi, path, issues, sourcePath) {
  if (!openapi?.paths || !(path in openapi.paths)) {
    issues.push(`${sourcePath}: missing required path ${path}`);
  }
}

function requireVersion(openapi, expected, issues, sourcePath) {
  if (openapi?.info?.version !== expected) {
    issues.push(`${sourcePath}: info.version must be ${expected}`);
  }
}
