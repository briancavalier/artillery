import { test } from "node:test";
import assert from "node:assert/strict";
import { createArtilleryAdapter } from "../packages/project-adapter-artillery/src/index.js";

test("project adapter deploy includes commit ref in hook request", async () => {
  const requests: string[] = [];
  const previousFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  process.env.FACTORY_COMMIT_SHA = "deadbeefcafebabe";
  const adapter = createArtilleryAdapter({
    dryRun: false,
    stagingHook: "http://deploy.test/deploy-hook?token=abc123",
    productionHook: undefined,
    localEventMode: true
  });

  try {
    const deploy = await adapter.deploy("staging", "SPEC-DEPLOY-1");
    assert.equal(deploy.status, "ok");
    assert.equal(requests.length, 1);

    const requestUrl = new URL(requests[0] ?? "");
    assert.equal(requestUrl.pathname, "/deploy-hook");
    assert.equal(requestUrl.searchParams.get("token"), "abc123");
    assert.equal(requestUrl.searchParams.get("ref"), "deadbeefcafebabe");
  } finally {
    delete process.env.FACTORY_COMMIT_SHA;
    globalThis.fetch = previousFetch;
  }
});
