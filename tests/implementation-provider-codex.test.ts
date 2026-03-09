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

test("validatePatchText rejects non-diff patch content", () => {
  const invalid = "const terrain = generateTerrain();";
  assert.equal(codexProviderInternals.isLikelyUnifiedDiff(invalid), false);
  assert.equal(
    codexProviderInternals.validatePatchText(invalid),
    "Codex returned PATCH content that is not a valid unified diff."
  );
});

test("validatePatchText accepts plausible unified diff", () => {
  const patch = [
    "diff --git a/apps/artillery-game/src/shared/simulation.ts b/apps/artillery-game/src/shared/simulation.ts",
    "--- a/apps/artillery-game/src/shared/simulation.ts",
    "+++ b/apps/artillery-game/src/shared/simulation.ts",
    "@@",
    "-const value = 1;",
    "+const value = 2;"
  ].join("\n");
  assert.equal(codexProviderInternals.isLikelyUnifiedDiff(patch), true);
  assert.equal(codexProviderInternals.validatePatchText(patch), "");
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
});
