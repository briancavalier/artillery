import { createArtilleryAdapter, readCloudEvents } from "@darkfactory/project-adapter-artillery";
import { runPipelineStep } from "@darkfactory/core";
import type { CloudEventEnvelope } from "@darkfactory/contracts";

const deployId = process.env.DEPLOY_ID;
if (!deployId) {
  console.error("[auto-rollback] DEPLOY_ID is required");
  process.exitCode = 1;
} else {
  const reason = process.env.REASON?.trim() || `Canary breach for deploy ${deployId}`;
  const events = await readCloudEvents();
  const specIds = deployedSpecsFor(events, deployId);

  if (specIds.length === 0) {
    console.log(`[auto-rollback] no staged/prod deployments found for deployId=${deployId}`);
  } else {
    const adapter = createArtilleryAdapter();
    let failed = false;

    for (const specId of specIds) {
      try {
        await runPipelineStep(adapter, {
          step: "rollback",
          specId,
          reason,
          deployId,
          actor: process.env.FACTORY_ACTOR ?? "factory_runner",
          source: process.env.FACTORY_SOURCE ?? "darkfactory.runner.auto_rollback"
        });
        console.log(`[auto-rollback] rolled back ${specId}`);
      } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[auto-rollback] failed for ${specId}: ${message}`);
      }
    }

    if (failed) {
      process.exitCode = 1;
    }
  }
}

function deployedSpecsFor(
  events: Array<CloudEventEnvelope<Record<string, unknown>>>,
  deployId: string
): string[] {
  const specIds = new Set<string>();

  for (const event of events) {
    if (event.type !== "pipeline_event") {
      continue;
    }

    const data = event.data as Record<string, unknown>;
    const action = String(data.action ?? "");
    const eventDeployId = String(data.deployId ?? "");
    const specId = String(data.specId ?? "");

    if ((action === "spec_deployed_staging" || action === "spec_deployed") && eventDeployId === deployId && specId) {
      specIds.add(specId);
    }
  }

  return [...specIds];
}
