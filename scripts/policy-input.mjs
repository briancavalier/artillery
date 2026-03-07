import { readdir, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

export async function generatePolicyInput(rootDir = process.cwd()) {
  const sourceFiles = await collectFiles(rootDir, ["apps", "packages"], [".ts"]);
  const imports = [];

  for (const file of sourceFiles) {
    const raw = await readFile(file, "utf8");
    const matches = [...raw.matchAll(/from\s+["']([^"']+)["']/g)];
    for (const match of matches) {
      const specifier = match[1];
      const fromRel = relativeFromRoot(rootDir, file);
      const toRel = resolveImport(rootDir, file, specifier);

      imports.push({
        from: fromRel,
        to: toRel,
        specifier,
        fromDomain: domainOf(fromRel),
        toDomain: domainOf(toRel)
      });
    }
  }

  const workflows = await collectWorkflowFacts(rootDir);
  const contracts = await collectContractFacts(rootDir);

  return {
    generatedAt: new Date().toISOString(),
    imports,
    workflows,
    contracts
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.cwd();
  const payload = await generatePolicyInput(rootDir);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function collectFiles(rootDir, dirs, extensions) {
  const files = [];
  for (const dir of dirs) {
    const base = join(rootDir, dir);
    const collected = await walk(base, extensions);
    files.push(...collected);
  }
  return files;
}

async function walk(path, extensions) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await walk(full, extensions)));
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(full);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function resolveImport(rootDir, fromFile, specifier) {
  if (specifier.startsWith(".")) {
    const resolved = resolve(dirname(fromFile), specifier);
    return relativeFromRoot(rootDir, resolved);
  }

  if (specifier.startsWith("@artillery/")) {
    return specifier === "@artillery/game" ? "apps/artillery-game" : specifier;
  }

  if (specifier.startsWith("@darkfactory/")) {
    if (specifier === "@darkfactory/contracts") {
      return "packages/factory-contracts";
    }
    if (specifier === "@darkfactory/core") {
      return "packages/factory-core";
    }
    if (specifier === "@darkfactory/runner") {
      return "packages/factory-runner";
    }
    if (specifier === "@darkfactory/project-adapter-artillery") {
      return "packages/project-adapter-artillery";
    }
  }

  return `external:${specifier}`;
}

function domainOf(path) {
  if (path.startsWith("apps/artillery-game")) {
    return "game";
  }
  if (path.startsWith("apps/factory-api")) {
    return "factory-api";
  }
  if (path.startsWith("packages/factory-contracts")) {
    return "contracts";
  }
  if (path.startsWith("packages/factory-core")) {
    return "factory-core";
  }
  if (path.startsWith("packages/factory-runner")) {
    return "factory-runner";
  }
  if (path.startsWith("packages/project-adapter-artillery")) {
    return "project-adapter";
  }
  if (path.startsWith("external:")) {
    return "external";
  }
  return "unknown";
}

async function collectWorkflowFacts(rootDir) {
  const files = await walk(join(rootDir, ".github/workflows"), [".yml", ".yaml"]);
  const out = [];

  for (const file of files) {
    const rel = relativeFromRoot(rootDir, file);
    const raw = await readFile(file, "utf8");
    const triggerPullRequest = /^\s*pull_request:/m.test(raw);
    const usesProdSecret = /RENDER_PROD_DEPLOY_HOOK|DATABASE_URL_PROD|PRODUCTION/i.test(raw);
    const usesEnvironmentProd = /environment:\s*production/i.test(raw);

    out.push({
      file: rel,
      triggerPullRequest,
      usesProdSecret,
      usesEnvironmentProd
    });
  }

  return out;
}

async function collectContractFacts(rootDir) {
  const openapiDir = join(rootDir, "packages/factory-contracts/openapi");
  const cloudeventsDir = join(rootDir, "packages/factory-contracts/cloudevents");

  const openapiFiles = await walk(openapiDir, [".json"]);
  const cloudeventFiles = await walk(cloudeventsDir, [".json"]);

  const issues = [];

  for (const file of openapiFiles) {
    const rel = relativeFromRoot(rootDir, file);
    if (!/\.v\d+\.json$/.test(rel)) {
      issues.push(`OpenAPI file must be versioned: ${rel}`);
      continue;
    }

    try {
      const payload = JSON.parse(await readFile(file, "utf8"));
      const versionFromName = rel.match(/\.v(\d+)\.json$/)?.[1];
      const infoVersion = String(payload?.info?.version ?? "");
      if (!versionFromName || !infoVersion.startsWith(`v${versionFromName}`)) {
        issues.push(`OpenAPI version mismatch in ${rel}: info.version=${infoVersion}`);
      }
    } catch {
      issues.push(`OpenAPI parse failed: ${rel}`);
    }
  }

  for (const file of cloudeventFiles) {
    const rel = relativeFromRoot(rootDir, file);
    if (!/\.v\d+\.schema\.json$/.test(rel) && !/cloudevents\.v\d+\.schema\.json$/.test(rel)) {
      issues.push(`CloudEvents schema must be versioned: ${rel}`);
    }

    if (/cloudevents\.v\d+\.schema\.json$/.test(rel)) {
      continue;
    }

    try {
      const payload = JSON.parse(await readFile(file, "utf8"));
      const required = payload?.properties?.data?.required ?? [];
      for (const field of ["specId", "scenarioId", "deployId", "matchId"]) {
        if (!required.includes(field)) {
          issues.push(`CloudEvents schema missing required correlation id ${field}: ${rel}`);
        }
      }
    } catch {
      issues.push(`CloudEvents parse failed: ${rel}`);
    }
  }

  return {
    openapiFiles: openapiFiles.map((file) => relativeFromRoot(rootDir, file)),
    cloudeventFiles: cloudeventFiles.map((file) => relativeFromRoot(rootDir, file)),
    issues
  };
}

function relativeFromRoot(rootDir, fullPath) {
  return fullPath.replace(`${rootDir}/`, "");
}
