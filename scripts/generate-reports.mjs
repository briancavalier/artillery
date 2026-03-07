import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ledgerPath = process.env.LEDGER_PATH ?? join(process.cwd(), "var/ledger/events.ndjson");
const reportDir = join(process.cwd(), "reports");

const events = await readLedger();
const byType = groupBy(events, (event) => event.type);

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
  `- Total agent events: ${(byType.get("agent_event") ?? []).length}`
]);

await writeMarkdown(join(reportDir, "feedback.md"), [
  "# User Feedback",
  ...events
    .filter((event) => event.type === "user_feedback")
    .slice(-50)
    .map((event) => `- ${event.at} ${event.actor}: ${String(event.metadata?.message ?? "")}`)
]);

console.log(`[reports] generated in ${reportDir}`);

async function readLedger() {
  try {
    const raw = await readFile(ledgerPath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function count(events, type, action) {
  return events.filter((event) => event.type === type && event.action === action).length;
}

function groupBy(items, selector) {
  const grouped = new Map();
  for (const item of items) {
    const key = selector(item);
    const value = grouped.get(key) ?? [];
    value.push(item);
    grouped.set(key, value);
  }
  return grouped;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function writeMarkdown(path, lines) {
  await mkdir(dirname(path), { recursive: true });
  const body = `${lines.filter(Boolean).join("\n")}\n`;
  await writeFile(path, body, "utf8");
}
