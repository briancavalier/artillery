import { runSpecArchitecture } from "./controller.js";

const repoFullName = process.env.GITHUB_REPOSITORY;
const [owner, repo] = repoFullName?.split("/") ?? [];

const result = await runSpecArchitecture({
  owner,
  repo,
  baseBranch: process.env.GITHUB_REF_NAME ?? "main",
  commitSha: process.env.GITHUB_SHA,
  actor: process.env.FACTORY_ACTOR ?? "spec_architect",
  source: process.env.FACTORY_SOURCE ?? "darkfactory.architecture",
  deployId: process.env.DEPLOY_ID,
  reportRootDir: process.cwd()
});

process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
