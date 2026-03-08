import { createArtilleryAdapter } from "@darkfactory/project-adapter-artillery";
import { GitHubExecutionApi } from "./github.js";
import { runSpecExecution } from "./controller.js";

const command = process.argv[2] ?? "act";
const repoFullName = process.env.GITHUB_REPOSITORY;
const [owner, repo] = repoFullName?.split("/") ?? [];
const token = process.env.GITHUB_TOKEN;

const github = token && owner && repo
  ? new GitHubExecutionApi(token)
  : undefined;

const result = await runSpecExecution({
  adapter: createArtilleryAdapter(),
  github,
  owner,
  repo,
  baseBranch: process.env.GITHUB_REF_NAME ?? "main",
  commitSha: process.env.GITHUB_SHA,
  actor: process.env.FACTORY_ACTOR ?? "spec_executor",
  source: process.env.FACTORY_SOURCE ?? "darkfactory.execution",
  deployId: process.env.DEPLOY_ID,
  reportRootDir: process.cwd(),
  queuePullRequests: command !== "advance",
  advanceSpecs: command !== "queue"
});

process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
