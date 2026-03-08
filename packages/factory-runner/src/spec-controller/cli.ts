import { appendFile, readFile } from "node:fs/promises";
import { GitHubRestApi } from "./github.js";
import { runSpecController } from "./controller.js";

const mode = process.argv[2] === "act" ? "act" : "analyze";
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!token) {
  throw new Error("GITHUB_TOKEN is required");
}

const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !repository.includes("/")) {
  throw new Error("GITHUB_REPOSITORY is required in owner/repo format");
}
const [owner, repo] = repository.split("/");

const eventPayload = await loadEventPayload(process.env.GITHUB_EVENT_PATH);
const prNumber = Number(process.env.PR_NUMBER ?? eventPayload?.pull_request?.number ?? eventPayload?.inputs?.pr_number);
if (!Number.isFinite(prNumber) || prNumber <= 0) {
  throw new Error("PR number is required via PR_NUMBER or event payload");
}

const labelName = String(eventPayload?.label?.name ?? "");
const actor = String(eventPayload?.sender?.login ?? "");
const deployId = process.env.DEPLOY_ID ?? `pr-${prNumber}-${mode}`;

const api = new GitHubRestApi(token);
const result = await runSpecController({
  api,
  owner,
  repo,
  prNumber,
  mode,
  event: {
    label: labelName || undefined,
    actor: actor || undefined
  },
  factoryApiBaseUrl: process.env.FACTORY_API_BASE_URL,
  deployId
});

await writeOutput("manifest_path", result.manifestPath);
await writeOutput("summary_path", result.summaryPath);
await writeOutput("same_repo", String(result.manifest.sameRepo));
await writeOutput("changed_specs", String(result.manifest.changedSpecPaths.length));
await writeOutput("auto_updated_specs", result.manifest.autoUpdate.updatedSpecIds.join(","));
await writeOutput("action_result", result.manifest.action.result);
await writeOutput("action_message", result.manifest.action.message);

console.log(`[spec-controller] mode=${mode} pr=#${prNumber}`);
console.log(`[spec-controller] manifest=${result.manifestPath}`);
console.log(`[spec-controller] action=${result.manifest.action.result} ${result.manifest.action.message}`);

async function loadEventPayload(path?: string): Promise<Record<string, any>> {
  if (!path) {
    return {};
  }
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return {};
  }
}

async function writeOutput(key: string, value: string): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  const line = `${key}=${escapeOutput(value)}\n`;
  await appendFile(outputPath, line, "utf8");
}

function escapeOutput(value: string): string {
  return value.replace(/\n/g, "%0A");
}
