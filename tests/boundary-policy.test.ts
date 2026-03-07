import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("policy checks pass for current import/workflow/contract boundaries", async () => {
  const { stdout, stderr } = await execFileAsync("node", ["scripts/policy-check.mjs"], {
    cwd: process.cwd(),
    env: process.env
  });

  assert.match(`${stdout}${stderr}`, /\[policy\]/);
});
