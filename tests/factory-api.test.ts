import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudEventEnvelope } from "@darkfactory/contracts";
import { createFactoryStore } from "../apps/factory-api/src/storage.js";

test("factory store ingests CloudEvents and reports centralized admin status", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-api-"));
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.FACTORY_STATE_PATH = join(workspace, "state.json");
  delete process.env.FACTORY_DATABASE_URL;

  const store = await createFactoryStore();

  try {
    const deployedEvent: CloudEventEnvelope<Record<string, unknown>> = {
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

    const gameEvents: Array<CloudEventEnvelope<Record<string, unknown>>> = [
      {
        specversion: "1.0",
        id: "evt-2",
        source: "test",
        type: "game_event",
        time: new Date().toISOString(),
        datacontenttype: "application/json",
        data: {
          action: "match_created",
          actor: "system",
          specId: "SPEC-UNBOUND",
          scenarioId: "SCN-0001",
          deployId: "DEPLOY-GAME-1",
          matchId: "MATCH-API-1",
          metadata: {}
        }
      },
      {
        specversion: "1.0",
        id: "evt-3",
        source: "test",
        type: "game_event",
        time: new Date().toISOString(),
        datacontenttype: "application/json",
        data: {
          action: "player_joined",
          actor: "system",
          specId: "SPEC-UNBOUND",
          scenarioId: "SCN-0001",
          deployId: "DEPLOY-GAME-1",
          matchId: "MATCH-API-1",
          metadata: {}
        }
      },
      {
        specversion: "1.0",
        id: "evt-4",
        source: "test",
        type: "game_event",
        time: new Date().toISOString(),
        datacontenttype: "application/json",
        data: {
          action: "match_ended",
          actor: "system",
          specId: "SPEC-UNBOUND",
          scenarioId: "SCN-0001",
          deployId: "DEPLOY-GAME-1",
          matchId: "MATCH-API-1",
          metadata: {}
        }
      }
    ];

    for (const event of [deployedEvent, ...gameEvents]) {
      await store.ingest(event);
    }

    const factoryBody = await store.getFactoryStatus();
    assert.equal(factoryBody.pipeline.deploymentsToday, 1);

    const eventsBody = { events: await store.getEvents({ type: "game_event", matchId: "MATCH-API-1", limit: 10, order: "asc" }) };
    assert.equal(eventsBody.events.length, 3);
    assert.equal(eventsBody.events[0]?.data.action, "match_created");

    const agents = await store.getAgentStatus();
    assert.equal(typeof agents.acceptanceRate, "number");

    const healthBody = await store.getProjectHealth();
    assert.equal(healthBody.metrics.matchesCreated, 1);
    assert.equal(healthBody.metrics.completionRate, 1);

    const canaryBody = await store.getProjectCanary();
    assert.equal(canaryBody.pass, true);

    const verifyBody = await store.verifyScenario("SCN-0001");
    assert.equal(verifyBody.passed, true);
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.FACTORY_STATE_PATH;
  }
});
