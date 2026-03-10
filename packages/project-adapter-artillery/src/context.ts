import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FeatureSpec } from "@darkfactory/contracts";
import type { ArchitectureContext, ArchitectureScope, ImplementationContext, ImplementationScope } from "@darkfactory/core";

interface ArchitectureIntegrationPoint {
  path: string;
  role: string;
  writeIntent: "edit" | "read-only";
  priority: number;
}

export async function buildArtilleryArchitectureContext(specDir: string, specId: string): Promise<ArchitectureContext> {
  const spec = await loadSpec(specDir, specId);
  const repoRoot = dirname(specDir);
  const relevantFiles = await collectSeedFiles(repoRoot, spec);
  return {
    specId,
    relevantFiles,
    readPaths: ["**"],
    seedFiles: relevantFiles,
    discoveryGoals: buildDiscoveryGoals(spec),
    discoveryBudget: {
      maxFiles: 32,
      maxBytes: 160_000
    },
    artifactRoot: `architecture/${specId}`,
    blockedPaths: [
      "apps/**",
      "packages/factory-core/**",
      "packages/factory-runner/**",
      ".github/workflows/**",
      "policy/**",
      ".env*",
      "render.yaml"
    ],
    reviewNotes: [
      "Produce architecture artifacts only; do not edit runtime code.",
      "Identify deterministic simulation seams before proposing terrain changes.",
      "Scenario coverage must map every required scenario to files and evidence hooks.",
      "Do not reference factory-plane mutation targets in architecture artifacts."
    ]
  };
}

export async function buildArtilleryImplementationContext(specDir: string, specId: string): Promise<ImplementationContext> {
  const spec = await loadSpec(specDir, specId);
  const repoRoot = dirname(specDir);
  const scope = getArtilleryImplementationScope(specId);
  const architectureArtifacts = await readArchitectureArtifacts(repoRoot, spec.specId);
  const seedFiles = unique([
    ...(architectureArtifacts.integrationPoints.map((entry) => entry.path)),
    ...(await collectSeedFiles(repoRoot, spec))
  ]);
  const relevantFiles = unique([
    ...architectureArtifacts.artifactPaths,
    ...(await collectRelevantFiles(repoRoot, spec))
  ]);

  return {
    specId,
    relevantFiles,
    readPaths: ["**"],
    seedFiles,
    discoveryGoals: buildDiscoveryGoals(spec),
    discoveryBudget: {
      maxFiles: architectureArtifacts.integrationPoints.length > 0 ? 24 : 40,
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
      ...architectureArtifacts.invariants.map((entry) => `${entry.id}: ${entry.description}`)
    ],
    maxFilesChanged: scope.maxFilesChanged
  };
}

export function getArtilleryArchitectureScope(specId: string): ArchitectureScope {
  return {
    artifactRoot: `architecture/${specId}`,
    allowedPaths: [
      `architecture/${specId}/**`,
      `specs/${specId}.json`,
      "reports/architecture/**"
    ],
    blockedPaths: [
      "apps/**",
      "packages/factory-core/**",
      "packages/factory-runner/**",
      ".github/workflows/**",
      "policy/**",
      ".env*",
      "render.yaml"
    ],
    maxFilesRead: 32
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

async function collectRelevantFiles(repoRoot: string, spec: FeatureSpec): Promise<string[]> {
  const candidates = [
    ...baseRelevantFiles(spec.specId),
    ...(spec.specId === "SPEC-0003" ? terrainDiscoverySeeds() : [])
  ];

  const files = new Set<string>();
  for (const candidate of candidates) {
    if (await exists(repoRoot, candidate)) {
      files.add(candidate);
    }
  }

  await mkdir(join(repoRoot, "evidence", spec.specId), { recursive: true }).catch(() => undefined);
  return [...files];
}

async function collectSeedFiles(repoRoot: string, spec: FeatureSpec): Promise<string[]> {
  const files = new Set<string>();
  for (const candidate of [
    ...baseRelevantFiles(spec.specId),
    ...(spec.specId === "SPEC-0003" ? terrainDiscoverySeeds() : [])
  ]) {
    if (await exists(repoRoot, candidate)) {
      files.add(candidate);
    }
  }
  return [...files];
}

async function readArchitectureArtifacts(repoRoot: string, specId: string): Promise<{
  integrationPoints: ArchitectureIntegrationPoint[];
  invariants: Array<{ id: string; description: string }>;
  artifactPaths: string[];
}> {
  const artifactRoot = `architecture/${specId}`;
  const integrationPointsPath = join(repoRoot, artifactRoot, "integration-points.json");
  const invariantsPath = join(repoRoot, artifactRoot, "invariants.json");
  const artifactCandidates = [
    `${artifactRoot}/README.md`,
    `${artifactRoot}/integration-points.json`,
    `${artifactRoot}/invariants.json`,
    `${artifactRoot}/scenario-trace.json`
  ];

  try {
    const [integrationPointsRaw, invariantsRaw] = await Promise.all([
      readFile(integrationPointsPath, "utf8"),
      readFile(invariantsPath, "utf8")
    ]);
    const artifactPaths: string[] = [];
    for (const candidate of artifactCandidates) {
      if (await exists(repoRoot, candidate)) {
        artifactPaths.push(candidate);
      }
    }
    return {
      integrationPoints: JSON.parse(integrationPointsRaw) as ArchitectureIntegrationPoint[],
      invariants: JSON.parse(invariantsRaw) as Array<{ id: string; description: string }>,
      artifactPaths
    };
  } catch {
    return {
      integrationPoints: [],
      invariants: [],
      artifactPaths: []
    };
  }
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

async function exists(rootDir: string, path: string): Promise<boolean> {
  try {
    await access(join(rootDir, path));
    return true;
  } catch {
    return false;
  }
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}
