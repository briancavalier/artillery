import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FeatureSpec } from "@darkfactory/contracts";
import type { ArchitectureContext, ArchitectureScope, ImplementationContext, ImplementationScope } from "@darkfactory/core";

export async function buildArtilleryImplementationContext(specDir: string, specId: string): Promise<ImplementationContext> {
  const spec = await loadSpec(specDir, specId);
  const scope = getArtilleryImplementationScope(specId);
  const architecture = await readArchitectureArtifacts(dirname(specDir), specId);
  const seedFiles = unique([
    ...(architecture?.integrationPoints.map((entry) => entry.path) ?? []),
    ...(await collectSeedFiles(spec))
  ]);
  const relevantFiles = unique([
    ...(architecture?.artifactPaths ?? []),
    ...(architecture?.integrationPoints.map((entry) => entry.path) ?? []),
    ...(await collectRelevantFiles(spec))
  ]);

  return {
    specId,
    relevantFiles,
    readPaths: ["**"],
    seedFiles,
    discoveryGoals: buildDiscoveryGoals(spec),
    discoveryBudget: {
      maxFiles: architecture?.integrationPoints.length ? 24 : 40,
      maxBytes: 200_000
    },
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
      "If the required scenarios are unsupported by adapter evidence generation, leave the PR open and blocked.",
      "Terrain changes must remain deterministic across replay and verification runs.",
      "Spawn placement must remain fair and on stable ground.",
      "Crater deformation must be replay-stable and must not break turn responsiveness.",
      ...(architecture?.invariants.map((entry) => `Architecture invariant: ${entry}`) ?? [])
    ],
    maxFilesChanged: scope.maxFilesChanged
  };
}

export async function buildArtilleryArchitectureContext(specDir: string, specId: string): Promise<ArchitectureContext> {
  const spec = await loadSpec(specDir, specId);
  const scope = getArtilleryArchitectureScope(specId);
  const seeds = await collectSeedFiles(spec);
  return {
    specId,
    relevantFiles: await collectRelevantFiles(spec),
    readPaths: ["**"],
    seedFiles: seeds,
    discoveryGoals: buildDiscoveryGoals(spec),
    reviewNotes: [
      "Architecture output must stay under architecture/<SpecID>/ only.",
      "List concrete integration points with ranked priority and write intent.",
      "List invariants the implementation worker must preserve.",
      "Cover every required scenario in the scenario trace artifact.",
      "Do not propose edits to factory-plane packages, workflows, or policy files."
    ],
    artifactRoot: scope.artifactRoot,
    blockedPaths: scope.blockedPaths
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

export function getArtilleryArchitectureScope(specId: string): ArchitectureScope {
  return {
    artifactRoot: `architecture/${specId}`,
    blockedPaths: [
      "apps/factory-api/**",
      "packages/factory-core/**",
      "packages/factory-runner/**",
      "packages/implementation-provider-codex/**",
      "apps/artillery-game/**",
      "tests/**",
      ".github/workflows/**",
      "policy/**",
      ".env*",
      "render.yaml"
    ]
  };
}

async function collectRelevantFiles(spec: FeatureSpec): Promise<string[]> {
  const candidates = [
    ...baseRelevantFiles(spec.specId),
    ...(spec.specId === "SPEC-0003" ? terrainDiscoverySeeds() : [])
  ];

  const files = new Set<string>();
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      files.add(candidate);
    }
  }

  await mkdir(join(process.cwd(), "evidence", spec.specId), { recursive: true }).catch(() => undefined);
  return [...files];
}

async function collectSeedFiles(spec: FeatureSpec): Promise<string[]> {
  const files = new Set<string>();
  for (const candidate of [
    ...baseRelevantFiles(spec.specId),
    ...(spec.specId === "SPEC-0003" ? terrainDiscoverySeeds() : [])
  ]) {
    if (await exists(candidate)) {
      files.add(candidate);
    }
  }
  return [...files];
}

function buildDiscoveryGoals(spec: FeatureSpec): string[] {
  if (spec.specId === "SPEC-0003") {
    return [
      "Find where terrain height and terrain state should be stored in shared simulation state.",
      "Find where player spawn validation and stable-ground placement should be enforced.",
      "Find where projectile impacts and crater deformation should be applied.",
      "Find how deterministic replay and state hashing are currently implemented.",
      "Find where match-start and turn responsiveness are most performance-sensitive."
    ];
  }

  return [
    "Find the primary simulation state and command application path.",
    "Find the existing tests and evidence generators that should be updated with the feature.",
    "Find the runtime entrypoints that render or expose the affected behavior."
  ];
}

function baseRelevantFiles(specId: string): string[] {
  return [
    "apps/artillery-game/src/shared/simulation.ts",
    "apps/artillery-game/src/shared/types.ts",
    "apps/artillery-game/src/server/match-store.ts",
    "apps/artillery-game/src/server/http.ts",
    "apps/artillery-game/src/client/main.ts",
    "apps/artillery-game/src/shared/determinism.ts",
    "tests/protocol.test.ts",
    "tests/determinism.test.ts",
    "packages/project-adapter-artillery/src/evidence.ts",
    `specs/${specId}.json`,
    `evidence/${specId}/README.md`
  ];
}

function terrainDiscoverySeeds(): string[] {
  return [
    "apps/artillery-game/src/shared/simulation.ts",
    "apps/artillery-game/src/shared/types.ts",
    "apps/artillery-game/src/shared/determinism.ts",
    "apps/artillery-game/src/server/match-store.ts",
    "apps/artillery-game/src/client/main.ts",
    "tests/determinism.test.ts",
    "tests/protocol.test.ts",
    "packages/project-adapter-artillery/src/evidence.ts"
  ];
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

async function readArchitectureArtifacts(rootDir: string, specId: string): Promise<{
  artifactPaths: string[];
  integrationPoints: Array<{ path: string; role: string; writeIntent: "edit" | "read-only"; priority: number }>;
  invariants: string[];
} | null> {
  const root = join(rootDir, "architecture", specId);
  const artifactPaths = [
    join("architecture", specId, "README.md"),
    join("architecture", specId, "integration-points.json"),
    join("architecture", specId, "invariants.json"),
    join("architecture", specId, "scenario-trace.json")
  ];
  const existsAll = await Promise.all(artifactPaths.map((candidate) => exists(join(rootDir, candidate))));
  if (existsAll.some((present) => !present)) {
    return null;
  }

  try {
    const integrationPoints = JSON.parse(await readFile(join(root, "integration-points.json"), "utf8")) as Array<{
      path: string;
      role: string;
      writeIntent: "edit" | "read-only";
      priority: number;
    }>;
    const invariants = JSON.parse(await readFile(join(root, "invariants.json"), "utf8")) as string[];
    return {
      artifactPaths,
      integrationPoints,
      invariants
    };
  } catch {
    return null;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
