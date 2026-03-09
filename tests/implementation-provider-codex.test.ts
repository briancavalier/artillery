import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImplementationTask } from "@darkfactory/contracts";
import { codexProviderInternals } from "../packages/implementation-provider-codex/src/provider.js";
import { createTempWorkspace } from "./helpers.js";

const execFileAsync = promisify(execFile);

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
    "## Selected Repository Context",
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
    "## Selected Repository Context",
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

test("parseContextBundleMetadata reads discovery fields from context bundle", () => {
  const parsed = codexProviderInternals.parseContextBundleMetadata([
    "# Accepted Spec SPEC-0003",
    "",
    "## Discovery Metadata",
    "```json",
    JSON.stringify({
      version: "v1",
      spec: {
        specId: "SPEC-0003",
        title: "High resolution terrain",
        intent: "Add deterministic terrain.",
        riskNotes: "Fairness regressions.",
        scenarios: [{ id: "SCN-0301", description: "Terrain generated", required: true }],
        verification: [{ scenarioId: "SCN-0301", checks: ["integration"] }]
      },
      context: {
        relevantFiles: ["apps/artillery-game/src/shared/simulation.ts"],
        readPaths: ["**"],
        seedFiles: ["apps/artillery-game/src/shared/simulation.ts"],
        discoveryGoals: ["Find terrain state integration points."],
        discoveryBudget: { maxFiles: 40, maxBytes: 200000 },
        allowedPaths: ["apps/artillery-game/**"],
        blockedPaths: ["apps/factory-api/**"],
        recommendedCommands: ["npm test"],
        evidenceCapabilities: [],
        reviewNotes: ["Stay deterministic."]
      }
    }, null, 2),
    "```"
  ].join("\n"));

  assert.equal(parsed?.spec.specId, "SPEC-0003");
  assert.deepEqual(parsed?.context?.seedFiles, ["apps/artillery-game/src/shared/simulation.ts"]);
  assert.deepEqual(parsed?.context?.discoveryGoals, ["Find terrain state integration points."]);
});

test("listRepoFiles excludes generated paths during discovery", async () => {
  const workspace = await createTempWorkspace();
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Tester"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "tester@example.com"], { cwd: workspace });
  await mkdir(join(workspace, "apps/artillery-game/src/shared"), { recursive: true });
  await mkdir(join(workspace, "dist"), { recursive: true });
  await writeFile(join(workspace, "apps/artillery-game/src/shared/simulation.ts"), "export const simulation = 1;\n", "utf8");
  await writeFile(join(workspace, "dist/generated.js"), "console.log('ignore');\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: workspace });

  const files = await codexProviderInternals.listRepoFiles(workspace, ["**"]);
  assert.deepEqual(files, ["apps/artillery-game/src/shared/simulation.ts"]);
});

test("scoreDiscoveryCandidates prioritizes seed files and keyword matches", () => {
  const candidates = codexProviderInternals.scoreDiscoveryCandidates(
    [
      "apps/artillery-game/src/shared/simulation.ts",
      "tests/determinism.test.ts",
      "packages/factory-core/src/engine.ts"
    ],
    ["apps/artillery-game/src/shared/simulation.ts"],
    new Set(["tests/determinism.test.ts"]),
    ["determin", "terrain"]
  );

  assert.equal(candidates[0]?.path, "apps/artillery-game/src/shared/simulation.ts");
  assert.match(candidates[0]?.reasons.join(" ") ?? "", /seed file/);
  assert.equal(candidates[1]?.path, "tests/determinism.test.ts");
});

test("selectContextFiles records selected files and reasons within budget", async () => {
  const workspace = await createTempWorkspace();
  await mkdir(join(workspace, "apps/artillery-game/src/shared"), { recursive: true });
  await mkdir(join(workspace, "tests"), { recursive: true });
  await writeFile(join(workspace, "apps/artillery-game/src/shared/simulation.ts"), "export const terrainSeed = 1;\n", "utf8");
  await writeFile(join(workspace, "tests/determinism.test.ts"), "test('determinism', () => true);\n", "utf8");

  const selection = await codexProviderInternals.selectContextFiles(workspace, [
    {
      path: "apps/artillery-game/src/shared/simulation.ts",
      score: 120,
      reasons: ["seed file"]
    },
    {
      path: "tests/determinism.test.ts",
      score: 75,
      reasons: ["path matches keywords: determin"]
    }
  ], { maxFiles: 2, maxBytes: 10_000 });

  assert.deepEqual(selection.selectedFiles, [
    "apps/artillery-game/src/shared/simulation.ts",
    "tests/determinism.test.ts"
  ]);
  assert.equal(selection.selectionReasons["apps/artillery-game/src/shared/simulation.ts"], "seed file");
  assert.equal(selection.budgetUsed.files, 2);
});
