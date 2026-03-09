import { runSpecExecution } from "./controller.js";

const repoFullName = process.env.GITHUB_REPOSITORY;
const [owner, repo] = repoFullName?.split("/") ?? [];

const result = await runSpecExecution({
  owner,
  repo,
  baseBranch: process.env.GITHUB_REF_NAME ?? "main",
  commitSha: process.env.GITHUB_SHA,
  actor: process.env.FACTORY_ACTOR ?? "spec_executor",
  source: process.env.FACTORY_SOURCE ?? "darkfactory.execution",
  deployId: process.env.DEPLOY_ID,
  reportRootDir: process.cwd()
});

process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
