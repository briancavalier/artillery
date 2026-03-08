import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createTempWorkspace } from "./helpers.js";

test("reports and feature proposals are generated from centralized factory events", async () => {
  const workspace = await createTempWorkspace();
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env.FACTORY_API_BASE_URL;
  delete process.env.FACTORY_EVENT_MODE;
  process.env.FACTORY_API_BASE_URL = "https://factory.test";

  const events = [
    makeEvent("1", "game_event", "match_created", { matchId: "match-001" }),
    makeEvent("2", "game_event", "match_ended", { matchId: "match-001" }),
    makeEvent("3", "user_feedback", "feedback_submitted", {
      matchId: "match-001",
      metadata: { message: "add replays and better wind indicators" }
    }),
    makeEvent("4", "pipeline_event", "spec_rollback", {
      specId: "SPEC-001",
      scenarioId: "SCN-001",
      deployId: "DEPLOY-001",
      metadata: { reason: "canary failed" }
    }),
    makeEvent("5", "incident", "rollback_triggered", {
      specId: "SPEC-001",
      scenarioId: "SCN-001",
      deployId: "DEPLOY-001",
      metadata: { reason: "canary failed" }
    })
  ];

  globalThis.fetch = createFactoryFetch(events);
  process.chdir(workspace);

  try {
    await import(`../packages/factory-runner/src/reports.js?test=${Date.now()}`);
    await import(`../packages/factory-runner/src/proposals.js?test=${Date.now() + 1}`);

    const gameHealth = await readFile(join(workspace, "reports/game-health.md"), "utf8");
    const factoryHealth = await readFile(join(workspace, "reports/factory-health.md"), "utf8");
    const proposals = await readFile(join(workspace, "reports/feature-proposals.md"), "utf8");

    assert.match(gameHealth, /Matches created: 1/);
    assert.match(gameHealth, /Completion rate: 100.0%/);
    assert.match(factoryHealth, /Rollbacks: 1/);
    assert.match(proposals, /Weekly Feature Proposals/);
    assert.match(proposals, /Confidence:/);
    assert.ok(events.some((event) => event.type === "agent_event" && event.data.action === "feature_proposed"));
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = previousFetch;
    if (previousBaseUrl === undefined) {
      delete process.env.FACTORY_API_BASE_URL;
    } else {
      process.env.FACTORY_API_BASE_URL = previousBaseUrl;
    }
  }
});

function createFactoryFetch(events: Array<any>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && url.pathname === "/v1/admin/events") {
      const filtered = filterEvents(events, Object.fromEntries(url.searchParams.entries()));
      return jsonResponse({ events: filtered });
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
  const filtered = events.filter((event) => {
    if (query.type && event.type !== query.type) {
      return false;
    }
    if (query.action && String(event.data?.action ?? "") !== query.action) {
      return false;
    }
    if (query.specId && String(event.data?.specId ?? "") !== query.specId) {
      return false;
    }
    if (query.deployId && String(event.data?.deployId ?? "") !== query.deployId) {
      return false;
    }
    if (query.matchId && String(event.data?.matchId ?? "") !== query.matchId) {
      return false;
    }
    return true;
  });

  filtered.sort((left, right) => String(left.time).localeCompare(String(right.time)));
  if (query.order !== "asc") {
    filtered.reverse();
  }

  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 5000);
  return filtered.slice(0, limit);
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function makeEvent(id: string, type: string, action: string, overrides: Record<string, unknown> = {}) {
  return {
    specversion: "1.0",
    id,
    source: "tests.observability",
    type,
    time: `2026-03-07T01:${id.padStart(2, "0")}:00.000Z`,
    datacontenttype: "application/json",
    data: {
      action,
      actor: "system",
      specId: "SPEC-UNBOUND",
      scenarioId: "SCN-UNBOUND",
      deployId: "DEPLOY-UNBOUND",
      matchId: "match-unbound",
      metadata: {},
      ...overrides
    }
  };
}
