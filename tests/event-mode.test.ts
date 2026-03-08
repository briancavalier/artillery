import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryStore } from "../apps/factory-api/src/storage.js";
import { readCloudEvents } from "../packages/project-adapter-artillery/src/index.js";

test("centralized event components fail fast when required config is missing", async () => {
  delete process.env.FACTORY_EVENT_MODE;
  delete process.env.FACTORY_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.FACTORY_STATE_PATH;
  delete process.env.FACTORY_API_BASE_URL;

  await assert.rejects(createFactoryStore(), /FACTORY_DATABASE_URL is required unless FACTORY_EVENT_MODE=local/);
  await assert.rejects(readCloudEvents(), /FACTORY_API_BASE_URL is required/);
});

test("explicit local mode allows event components without Postgres", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "event-mode-local-"));
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.FACTORY_STATE_PATH = join(workspace, "factory-state.json");
  delete process.env.FACTORY_DATABASE_URL;

  const store = await createFactoryStore();

  try {
    const status = await store.getFactoryStatus();
    assert.equal(status.status, "ok");
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.FACTORY_STATE_PATH;
  }
});
