import { test } from "node:test";
import assert from "node:assert/strict";
import { getProjectCanary, getProjectHealth, verifyProjectScenario } from "../apps/artillery-game/src/server/ledger.js";

test("game project-control helpers proxy centralized factory telemetry", async () => {
  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env.FACTORY_API_BASE_URL;
  delete process.env.FACTORY_EVENT_MODE;
  process.env.FACTORY_API_BASE_URL = "https://factory.test";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && url.pathname === "/v1/admin/project-health") {
      return jsonResponse({
        status: "ok",
        generatedAt: new Date().toISOString(),
        metrics: {
          matchesCreated: 1,
          matchesCompleted: 1,
          commandRejections: 0,
          disconnects: 0,
          completionRate: 1
        }
      });
    }

    if (method === "POST" && url.pathname === "/v1/admin/project/canary") {
      return jsonResponse({
        generatedAt: new Date().toISOString(),
        pass: true,
        metrics: {
          rejectRate: 0,
          disconnects: 0
        }
      });
    }

    if (method === "POST" && url.pathname === "/v1/admin/project/scenarios/SCN-0001/verify") {
      return jsonResponse({
        scenarioId: "SCN-0001",
        passed: true,
        details: { created: 1, joined: 1 }
      });
    }

    return new Response(JSON.stringify({ error: `Unhandled ${method} ${url.pathname}` }), { status: 404 });
  }) as typeof fetch;

  try {
    const health = await getProjectHealth();
    assert.equal(health.metrics.matchesCreated, 1);
    assert.equal(health.metrics.completionRate, 1);

    const canary = await getProjectCanary();
    assert.equal(canary.pass, true);

    const verify = await verifyProjectScenario("SCN-0001");
    assert.equal(verify.passed, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBaseUrl === undefined) {
      delete process.env.FACTORY_API_BASE_URL;
    } else {
      process.env.FACTORY_API_BASE_URL = previousBaseUrl;
    }
  }
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
