import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryApiServer } from "../apps/factory-api/src/index.js";

test("factory api ingests CloudEvents and reports admin status", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-api-"));
  process.env.FACTORY_STATE_PATH = join(workspace, "state.json");
  delete process.env.FACTORY_DATABASE_URL;

  const server = await createFactoryApiServer();
  await server.listen(0);
  const base = `http://127.0.0.1:${server.port()}`;

  try {
    const event = {
      specversion: "1.0",
      id: "evt-1",
      source: "test",
      type: "pipeline_event",
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      data: {
        action: "spec_deployed",
        actor: "deployer_agent",
        specId: "SPEC-API-1",
        scenarioId: "SCN-API-1",
        deployId: "DEPLOY-API-1",
        matchId: "MATCH-API-1",
        metadata: {}
      }
    };

    const ingest = await fetch(`${base}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event)
    });
    assert.equal(ingest.status, 202);

    const factory = await fetch(`${base}/v1/admin/factory`);
    assert.equal(factory.status, 200);
    const factoryBody = await factory.json() as { pipeline: { deploymentsToday: number } };
    assert.equal(factoryBody.pipeline.deploymentsToday, 1);

    const agents = await fetch(`${base}/v1/admin/agents`);
    assert.equal(agents.status, 200);

    const root = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/dashboard");

    const dashboard = await fetch(`${base}/dashboard`);
    assert.equal(dashboard.status, 200);
    const contentType = dashboard.headers.get("content-type");
    assert.ok(contentType?.includes("text/html"));
    const html = await dashboard.text();
    assert.match(html, /Dark Factory Dashboard/);
    assert.match(html, /Recent Deployments/);
  } finally {
    await server.close();
    delete process.env.FACTORY_STATE_PATH;
  }
});
