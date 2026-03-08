import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createArtilleryAdapter } from "../packages/project-adapter-artillery/src/index.js";

test("project adapter deploy includes commit ref in hook request", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200);
    response.end("ok");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const hook = `http://127.0.0.1:${address.port}/deploy-hook?token=abc123`;

  process.env.FACTORY_COMMIT_SHA = "deadbeefcafebabe";
  const adapter = createArtilleryAdapter({
    dryRun: false,
    stagingHook: hook,
    productionHook: undefined
  });

  try {
    const deploy = await adapter.deploy("staging", "SPEC-DEPLOY-1");
    assert.equal(deploy.status, "ok");
    assert.equal(requests.length, 1);

    const requestUrl = new URL(`http://127.0.0.1${requests[0]}`);
    assert.equal(requestUrl.pathname, "/deploy-hook");
    assert.equal(requestUrl.searchParams.get("token"), "abc123");
    assert.equal(requestUrl.searchParams.get("ref"), "deadbeefcafebabe");
  } finally {
    delete process.env.FACTORY_COMMIT_SHA;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
