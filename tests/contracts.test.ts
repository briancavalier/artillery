import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

test("project-control and factory-admin OpenAPI contracts expose required endpoints", async () => {
  const projectControl = JSON.parse(await readFile(join(root, "packages/factory-contracts/openapi/project-control.v1.json"), "utf8"));
  const factoryAdmin = JSON.parse(await readFile(join(root, "packages/factory-contracts/openapi/factory-admin.v1.json"), "utf8"));

  assert.equal(projectControl.info.version, "v1");
  assert.equal(factoryAdmin.info.version, "v1");

  for (const path of [
    "/v1/project/health",
    "/v1/project/canary",
    "/v1/project/scenarios/{scenarioId}/verify",
    "/v1/project/rollback"
  ]) {
    assert.ok(projectControl.paths[path], `missing project-control path ${path}`);
  }

  for (const path of [
    "/v1/admin/factory",
    "/v1/admin/events",
    "/v1/admin/agents",
    "/v1/admin/deployments",
    "/v1/admin/project-health",
    "/v1/admin/project/canary",
    "/v1/admin/project/scenarios/{scenarioId}/verify",
    "/v1/events"
  ]) {
    assert.ok(factoryAdmin.paths[path], `missing factory-admin path ${path}`);
  }
});

test("CloudEvents schemas require correlation ids for every event type", async () => {
  const schemaNames = [
    "game_event.v1.schema.json",
    "pipeline_event.v1.schema.json",
    "agent_event.v1.schema.json",
    "user_feedback.v1.schema.json",
    "incident.v1.schema.json"
  ];

  for (const name of schemaNames) {
    const schema = JSON.parse(
      await readFile(join(root, "packages/factory-contracts/cloudevents", name), "utf8")
    );

    const required = schema?.properties?.data?.required;
    assert.ok(Array.isArray(required), `${name} missing data.required array`);

    for (const field of ["specId", "scenarioId", "deployId", "matchId", "action", "actor"]) {
      assert.ok(required.includes(field), `${name} missing data.${field}`);
    }
  }
});
