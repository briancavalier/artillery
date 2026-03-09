import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImplementationTask } from "@darkfactory/contracts";
import { codexProviderInternals } from "../packages/implementation-provider-codex/src/provider.js";

const task: ImplementationTask = {
  taskId: "task-1",
  specId: "SPEC-TEST-1",
  source: "human",
  owner: "@maintainer",
  repo: "owner/repo",
  baseBranch: "main",
  baseSha: "abc123",
  targetBranch: "codex/implement-spec-test-1",
  allowedPaths: ["apps/artillery-game/**", "tests/**"],
  verificationTargets: ["SCN-0001"],
  contextBundleRef: "reports/implementation-context/SPEC-TEST-1.md",
  attempt: 0,
  priority: 100,
  limits: {
    maxTurns: 6,
    maxDurationMs: 900000,
    maxCostUsd: 5,
    maxFilesChanged: 24
  },
  policy: {
    allowAutoMerge: true,
    allowShell: true,
    allowNetwork: false,
    blockedPaths: ["packages/factory-core/**"]
  },
  status: "queued",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

test("checkPatchText rejects non-diff patch content", () => {
  const invalid = "const terrain = generateTerrain();";
  assert.equal(codexProviderInternals.isLikelyUnifiedDiff(invalid), false);
  assert.deepEqual(codexProviderInternals.checkPatchText(invalid), {
    kind: "format",
    message: "Codex returned PATCH content that is not a valid unified diff."
  });
});

test("checkPatchText accepts plausible unified diff", () => {
  const patch = [
    "diff --git a/apps/artillery-game/src/shared/simulation.ts b/apps/artillery-game/src/shared/simulation.ts",
    "--- a/apps/artillery-game/src/shared/simulation.ts",
    "+++ b/apps/artillery-game/src/shared/simulation.ts",
    "@@",
    "-const value = 1;",
    "+const value = 2;"
  ].join("\n");
  assert.equal(codexProviderInternals.isLikelyUnifiedDiff(patch), true);
  assert.deepEqual(codexProviderInternals.checkPatchText(patch), { kind: "ok", message: "" });
});

test("classifyBlockedResponse accepts blocked summary with empty patch", () => {
  assert.deepEqual(
    codexProviderInternals.classifyBlockedResponse(
      "Blocked: SPEC-0003 contents unavailable, so implementation cannot proceed safely.",
      ""
    ),
    {
      blocked: true,
      reason: "Blocked: SPEC-0003 contents unavailable, so implementation cannot proceed safely."
    }
  );
});

test("classifyBlockedResponse does not hide a non-empty patch", () => {
  const patch = [
    "diff --git a/docs/SPEC-0003-blocker.md b/docs/SPEC-0003-blocker.md",
    "--- a/docs/SPEC-0003-blocker.md",
    "+++ b/docs/SPEC-0003-blocker.md",
    "@@",
    "-old",
    "+new"
  ].join("\n");
  assert.deepEqual(
    codexProviderInternals.classifyBlockedResponse("Blocked: incomplete spec.", patch),
    { blocked: false }
  );
});

test("renderRepairPrompt includes validation feedback and prior output", () => {
  const prompt = codexProviderInternals.renderRepairPrompt(
    task,
    "# Context bundle",
    "SUMMARY:\nI changed files.\nPATCH:\n```diff\nnot a diff\n```",
    "Codex returned PATCH content that is not a valid unified diff."
  );
  assert.match(prompt, /Validation error: Codex returned PATCH content that is not a valid unified diff\./);
  assert.match(prompt, /Previous invalid output:/);
  assert.match(prompt, /Allowed paths: apps\/artillery-game\/\*\*, tests\/\*\*\./);
  assert.match(prompt, /If you are blocked, start SUMMARY with 'Blocked:' and leave PATCH empty\./);
  assert.match(prompt, /do not use 'new file mode', '\/dev\/null', or '@@ -0,0' headers/i);
});

test("extractPatchedPaths returns touched files from unified diff", () => {
  const patch = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@",
    "-old",
    "+new",
    "diff --git a/apps/artillery-game/src/shared/simulation.ts b/apps/artillery-game/src/shared/simulation.ts",
    "--- a/apps/artillery-game/src/shared/simulation.ts",
    "+++ b/apps/artillery-game/src/shared/simulation.ts",
    "@@",
    "-const value = 1;",
    "+const value = 2;"
  ].join("\n");
  assert.deepEqual(codexProviderInternals.extractPatchedPaths(patch), [
    "README.md",
    "apps/artillery-game/src/shared/simulation.ts"
  ]);
});

test("renderApplyRepairPrompt includes apply error and file snapshots", () => {
  const prompt = codexProviderInternals.renderApplyRepairPrompt(
    task,
    "# Context bundle",
    "SUMMARY:\nI changed files.\nPATCH:\n```diff\n...\n```",
    "error: patch failed: README.md:1",
    "FILE: README.md\n```\ncurrent contents\n```"
  );
  assert.match(prompt, /git apply error: error: patch failed: README\.md:1/);
  assert.match(prompt, /Current file snapshots for the touched files:/);
  assert.match(prompt, /Do not modify unrelated files such as README\.md unless the spec explicitly requires it\./);
});

test("extractPatchedPaths ignores scratch paths not present in unified diff headers", () => {
  const patch = [
    "diff --git a/apps/artillery-game/src/client/main.ts b/apps/artillery-game/src/client/main.ts",
    "--- a/apps/artillery-game/src/client/main.ts",
    "+++ b/apps/artillery-game/src/client/main.ts",
    "@@",
    "-const ready = false;",
    "+const ready = true;"
  ].join("\n");
  assert.deepEqual(codexProviderInternals.extractPatchedPaths(patch), [
    "apps/artillery-game/src/client/main.ts"
  ]);
});
