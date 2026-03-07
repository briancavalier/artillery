import { createArtilleryAdapter } from "@darkfactory/project-adapter-artillery";
import { runPipelineStep, type PipelineStep } from "@darkfactory/core";

const step = process.argv[2] as PipelineStep | undefined;
const specId = process.env.SPEC_ID ?? process.argv[3];
const reason = process.env.REASON ?? process.argv[4];

const validSteps: PipelineStep[] = [
  "critic",
  "evaluate",
  "refine",
  "accept",
  "veto",
  "implement",
  "verify",
  "deploy",
  "rollback"
];

if (!step || !validSteps.includes(step)) {
  console.log("Usage: node dist/packages/factory-runner/src/cli.js <critic|evaluate|refine|accept|veto|implement|verify|deploy|rollback> [SPEC_ID] [REASON]");
  process.exitCode = 1;
} else {
  const adapter = createArtilleryAdapter();
  await runPipelineStep(adapter, {
    step,
    specId,
    reason,
    deployMode: (process.env.FACTORY_DEPLOY_MODE as "promote" | "staging-only" | "production-only" | undefined) ?? "promote",
    actor: process.env.FACTORY_ACTOR ?? "factory_runner",
    source: process.env.FACTORY_SOURCE ?? "darkfactory.runner",
    deployId: process.env.DEPLOY_ID
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
