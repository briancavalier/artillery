import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generatePolicyInput } from "./policy-input.mjs";

const payload = await generatePolicyInput(process.cwd());
const denies = evaluateLocally(payload);

if (denies.length > 0) {
  for (const denial of denies) {
    console.error(`[policy] ${denial}`);
  }
  process.exitCode = 1;
}

const opaAvailable = spawnSync("opa", ["version"], { stdio: "ignore" }).status === 0;
if (opaAvailable) {
  const tempDir = await mkdtemp(join(tmpdir(), "darkfactory-policy-"));
  const inputPath = join(tempDir, "input.json");
  await writeFile(inputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const run = spawnSync(
    "opa",
    [
      "eval",
      "--fail-defined",
      "-d",
      "policy/opa",
      "-i",
      inputPath,
      "data.darkfactory.deny[_]"
    ],
    { stdio: "inherit" }
  );

  await rm(tempDir, { recursive: true, force: true });

  if (run.status !== 0) {
    process.exitCode = 1;
  }
} else {
  console.log("[policy] OPA not installed locally. Local JS policy checks completed.");
}

if (process.exitCode !== 1) {
  console.log("[policy] checks passed");
}

function evaluateLocally(input) {
  const out = [];

  for (const edge of input.imports) {
    if (["factory-core", "factory-runner", "factory-api"].includes(edge.fromDomain) && edge.toDomain === "game") {
      out.push(`factory plane import boundary violation: ${edge.from} -> ${edge.to}`);
    }

    if (edge.fromDomain === "game" && ["factory-core", "factory-runner", "project-adapter"].includes(edge.toDomain)) {
      out.push(`game plane may not import factory internals: ${edge.from} -> ${edge.to}`);
    }
  }

  for (const workflow of input.workflows) {
    if (workflow.triggerPullRequest && (workflow.usesProdSecret || workflow.usesEnvironmentProd)) {
      out.push(`PR workflow may not reference prod secrets or production env: ${workflow.file}`);
    }
  }

  for (const issue of input.contracts.issues) {
    out.push(`contract version policy violation: ${issue}`);
  }

  return out;
}
