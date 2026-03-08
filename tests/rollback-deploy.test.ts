import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createTempWorkspace, readJson, writeJson } from "./helpers.js";

test("auto-rollback resolves deployments from centralized factory events", async () => {
  const workspace = await createTempWorkspace();
  const specPath = join(workspace, "specs/SPEC-RB-001.json");
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env.FACTORY_API_BASE_URL;
  delete process.env.FACTORY_EVENT_MODE;
  process.env.FACTORY_API_BASE_URL = "https://factory.test";
  process.env.DEPLOY_ID = "DEPLOY-RB-1";
  process.env.REASON = "canary failed";

  await writeJson(specPath, {
    specId: "SPEC-RB-001",
    title: "Rollback test spec",
    source: "human",
    owner: "@maintainer",
    status: "Deployed",
    decision: "accept",
    intent: "Validate centralized rollback lookup and event emission.",
    scenarios: [
      { id: "SCN-001", description: "scenario one", required: true }
    ],
    verification: [
      { scenarioId: "SCN-001", checks: ["unit"] }
    ],
    riskNotes: "Risk: rollback lookup misses deployment events. Mitigation: query centralized sink.",
    createdAt: "2026-03-07T00:00:00.000Z",
    updatedAt: "2026-03-07T00:00:00.000Z"
  });

  const events = [
    {
      specversion: "1.0",
      id: "evt-deploy-1",
      source: "tests.rollback-deploy",
      type: "pipeline_event",
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      data: {
        action: "spec_deployed",
        actor: "deployer_agent",
        specId: "SPEC-RB-001",
        scenarioId: "SCN-001",
        deployId: "DEPLOY-RB-1",
        matchId: "MATCH-UNBOUND",
        metadata: {}
      }
    }
  ];

  globalThis.fetch = createFactoryFetch(events);
  process.chdir(workspace);

  try {
    await import(`../packages/factory-runner/src/rollback-deploy.js?test=${Date.now()}`);

    const spec = await readJson<{ status: string; decision: string }>(specPath);
    assert.equal(spec.status, "Refined");
    assert.equal(spec.decision, "rollback");
    assert.ok(events.some((event) => event.data.action === "spec_rollback"));
    assert.ok(events.some((event) => event.data.action === "rollback_triggered"));
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = previousFetch;
    if (previousBaseUrl === undefined) {
      delete process.env.FACTORY_API_BASE_URL;
    } else {
      process.env.FACTORY_API_BASE_URL = previousBaseUrl;
    }
    delete process.env.DEPLOY_ID;
    delete process.env.REASON;
  }
});

function createFactoryFetch(events: Array<any>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && url.pathname === "/v1/admin/events") {
      return jsonResponse({ events: filterEvents(events, Object.fromEntries(url.searchParams.entries())) });
    }

    if (method === "POST" && url.pathname === "/v1/events") {
      const rawBody = typeof init?.body === "string" ? init.body : "";
      events.push(JSON.parse(rawBody));
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }

    return new Response(JSON.stringify({ error: `Unhandled ${method} ${url.pathname}` }), { status: 404 });
  }) as typeof fetch;
}

function filterEvents(events: Array<any>, query: Record<string, string>): Array<any> {
  return events.filter((event) =>
    (!query.type || event.type === query.type) &&
    (!query.deployId || String(event.data?.deployId ?? "") === query.deployId)
  );
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
