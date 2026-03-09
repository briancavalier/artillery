import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FeatureSpec } from "@darkfactory/contracts";
import type { ImplementationContext, ImplementationScope } from "@darkfactory/core";

export async function buildArtilleryImplementationContext(specDir: string, specId: string): Promise<ImplementationContext> {
  const spec = await loadSpec(specDir, specId);
  const scope = getArtilleryImplementationScope(specId);
  const relevantFiles = await collectRelevantFiles(spec, specDir);

  return {
    specId,
    relevantFiles,
    allowedPaths: scope.allowedPaths,
    blockedPaths: scope.blockedPaths,
    recommendedCommands: [
      "npm test",
      "npm run contract:check",
      "npm run policy:check",
      `npm run factory:verify -- ${specId}`
    ],
    evidenceCapabilities: spec.scenarios
      .filter((scenario) => ["SCN-0001", "SCN-0002", "SCN-0003"].includes(scenario.id))
      .map((scenario) => scenario.id),
    reviewNotes: [
      "Do not edit factory-plane packages from the implementation worker.",
      "Keep changes inside the allowed path set for the project adapter.",
      "Update tests alongside implementation changes.",
      "If the required scenarios are unsupported by adapter evidence generation, leave the PR open and blocked."
    ],
    maxFilesChanged: scope.maxFilesChanged
  };
}

export function getArtilleryImplementationScope(specId: string): ImplementationScope {
  return {
    allowedPaths: [
      "apps/artillery-game/**",
      "tests/**",
      `evidence/${specId}/**`,
      "docs/**"
    ],
    blockedPaths: [
      "apps/factory-api/**",
      "packages/factory-core/**",
      "packages/factory-runner/**",
      "packages/implementation-provider-codex/**",
      ".github/workflows/**",
      "policy/**",
      ".env*",
      "render.yaml"
    ],
    maxFilesChanged: 24
  };
}

async function collectRelevantFiles(spec: FeatureSpec, specDir: string): Promise<string[]> {
  const candidates = [
    "apps/artillery-game/src/shared/simulation.ts",
    "apps/artillery-game/src/shared/types.ts",
    "apps/artillery-game/src/server/match-store.ts",
    "apps/artillery-game/src/server/http.ts",
    "tests/protocol.test.ts",
    "tests/determinism.test.ts",
    `specs/${spec.specId}.json`,
    `evidence/${spec.specId}/README.md`
  ];

  const files: string[] = [];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      files.push(candidate);
    }
  }

  await mkdir(join(process.cwd(), "evidence", spec.specId), { recursive: true }).catch(() => undefined);
  return files;
}

async function loadSpec(specDir: string, specId: string): Promise<FeatureSpec> {
  const entries = await readdir(specDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const raw = await readFile(join(specDir, entry.name), "utf8");
    const parsed = JSON.parse(raw) as FeatureSpec;
    if (parsed.specId === specId) {
      return parsed;
    }
  }
  throw new Error(`Spec not found: ${specId}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
