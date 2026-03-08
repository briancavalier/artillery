import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readCloudEvents } from "@darkfactory/project-adapter-artillery";
import type { CloudEventEnvelope } from "@darkfactory/contracts";

const reportDir = join(process.cwd(), "reports");
const events = await readCloudEvents(undefined, { limit: 5000, order: "asc" });

const game = {
  matchesCreated: count(events, "game_event", "match_created"),
  matchesEnded: count(events, "game_event", "match_ended"),
  disconnects: count(events, "game_event", "player_disconnected"),
  commandRejects: count(events, "game_event", "command_rejected")
};

const factory = {
  specsCritiqued: count(events, "pipeline_event", "spec_critiqued"),
  specsAccepted: count(events, "pipeline_event", "spec_accepted"),
  specsVetoed: count(events, "pipeline_event", "spec_vetoed"),
  specsVerified: count(events, "pipeline_event", "spec_verified"),
  specsDeployed: count(events, "pipeline_event", "spec_deployed"),
  rollbacks: count(events, "pipeline_event", "spec_rollback"),
  gateFailures: count(events, "pipeline_event", "gate_failed")
};

const agents = {
  proposals: count(events, "agent_event", "feature_proposed"),
  acceptedProposals: count(events, "agent_event", "proposal_accepted")
};

await mkdir(reportDir, { recursive: true });

await writeMarkdown(join(reportDir, "game-health.md"), [
  "# Game Health",
  `- Generated: ${new Date().toISOString()}`,
  `- Matches created: ${game.matchesCreated}`,
  `- Matches ended: ${game.matchesEnded}`,
  `- Completion rate: ${percent(game.matchesCreated ? game.matchesEnded / game.matchesCreated : 0)}`,
  `- Disconnects: ${game.disconnects}`,
  `- Command rejects: ${game.commandRejects}`
]);

await writeMarkdown(join(reportDir, "factory-health.md"), [
  "# Factory Health",
  `- Generated: ${new Date().toISOString()}`,
  `- Specs critiqued: ${factory.specsCritiqued}`,
  `- Specs accepted: ${factory.specsAccepted}`,
  `- Specs vetoed: ${factory.specsVetoed}`,
  `- Specs verified: ${factory.specsVerified}`,
  `- Specs deployed: ${factory.specsDeployed}`,
  `- Gate failures: ${factory.gateFailures}`,
  `- Rollbacks: ${factory.rollbacks}`
]);

await writeMarkdown(join(reportDir, "agent-quality.md"), [
  "# Agent Quality",
  `- Generated: ${new Date().toISOString()}`,
  `- Agent proposals: ${agents.proposals}`,
  `- Accepted proposals: ${agents.acceptedProposals}`,
  `- Acceptance rate: ${percent(agents.proposals ? agents.acceptedProposals / agents.proposals : 0)}`,
  `- Regression rate: ${percent(factory.specsDeployed ? factory.rollbacks / factory.specsDeployed : 0)}`
]);

await writeMarkdown(join(reportDir, "feedback.md"), [
  "# User Feedback",
  ...events
    .filter((event) => event.type === "user_feedback")
    .slice(-50)
    .map((event) => {
      const data = extractData(event);
      return `- ${event.time} ${String(data.actor ?? "unknown")}: ${String(data.metadata?.message ?? "")}`;
    })
]);

console.log(`[reports] generated in ${reportDir}`);

function count(events: Array<CloudEventEnvelope<Record<string, unknown>>>, type: string, action: string): number {
  return events.filter((event) => {
    const data = extractData(event);
    return event.type === type && data.action === action;
  }).length;
}

function extractData(event: CloudEventEnvelope<Record<string, unknown>>): Record<string, any> {
  return event.data as Record<string, any>;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function writeMarkdown(path: string, lines: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.filter(Boolean).join("\n")}\n`, "utf8");
}
