import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createArtilleryAdapter, readCloudEvents } from "@darkfactory/project-adapter-artillery";
import type { CloudEventEnvelope } from "@darkfactory/contracts";

const adapter = createArtilleryAdapter();
const events = await readCloudEvents(undefined, { limit: 5000, order: "asc" });
const feedback = events.filter((event) => event.type === "user_feedback");
const incidents = events.filter((event) => event.type === "incident");

const keywordCounts = new Map<string, number>();
for (const event of feedback) {
  const message = String(extractData(event).metadata?.message ?? "").toLowerCase();
  for (const token of message.split(/[^a-z0-9]+/g)) {
    if (token.length < 4) {
      continue;
    }
    keywordCounts.set(token, (keywordCounts.get(token) ?? 0) + 1);
  }
}

const topKeywords = [...keywordCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
const proposals: Array<{ title: string; why: string; confidence: number }> = [];

if (topKeywords.length > 0) {
  proposals.push({
    title: "Player-requested improvements",
    why: `Most common feedback terms: ${topKeywords.map(([word, count]) => `${word}(${count})`).join(", ")}`,
    confidence: 0.72
  });
}

if (incidents.length > 0) {
  proposals.push({
    title: "Resilience hardening",
    why: `${incidents.length} incidents observed, prioritize rollback diagnostics and recovery automation`,
    confidence: 0.81
  });
}

if (proposals.length === 0) {
  proposals.push({
    title: "Gameplay depth expansion",
    why: "Low incident pressure and limited feedback signal suggest safe expansion of gameplay mechanics",
    confidence: 0.55
  });
}

const reportLines = [
  "# Weekly Feature Proposals",
  `- Generated: ${new Date().toISOString()}`,
  "- Source: CloudEvents telemetry + user feedback + incidents",
  ""
];

for (const proposal of proposals) {
  reportLines.push(`## ${proposal.title}`);
  reportLines.push(`- Why: ${proposal.why}`);
  reportLines.push(`- Confidence: ${(proposal.confidence * 100).toFixed(0)}%`);
  reportLines.push("");

  const event: CloudEventEnvelope<Record<string, unknown>> = {
    specversion: "1.0",
    id: randomUUID(),
    source: "darkfactory.runner.proposals",
    type: "agent_event",
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: {
      action: "feature_proposed",
      actor: "learning_agent",
      specId: "SPEC-UNBOUND",
      scenarioId: "SCN-UNBOUND",
      deployId: process.env.DEPLOY_ID ?? "deploy-unbound",
      matchId: "match-unbound",
      metadata: proposal
    }
  };

  await adapter.appendEvent(event);
}

await mkdir(join(process.cwd(), "reports"), { recursive: true });
await writeFile(join(process.cwd(), "reports/feature-proposals.md"), `${reportLines.join("\n")}\n`, "utf8");
console.log("[feature-proposals] generated reports/feature-proposals.md");

function extractData(event: CloudEventEnvelope<Record<string, unknown>>): Record<string, any> {
  return event.data as Record<string, any>;
}
