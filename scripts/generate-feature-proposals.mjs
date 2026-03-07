import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { appendLedgerEvent } from "./lib/spec-store.mjs";

const ledgerPath = process.env.LEDGER_PATH ?? join(process.cwd(), "var/ledger/events.ndjson");
const outputPath = join(process.cwd(), "reports/feature-proposals.md");

const events = await readLedger();
const feedback = events.filter((event) => event.type === "user_feedback");
const incidents = events.filter((event) => event.type === "incident");

const keywordCounts = new Map();
for (const event of feedback) {
  const message = String(event.metadata?.message ?? "").toLowerCase();
  for (const token of message.split(/[^a-z0-9]+/g)) {
    if (token.length < 4) {
      continue;
    }
    keywordCounts.set(token, (keywordCounts.get(token) ?? 0) + 1);
  }
}

const topKeywords = [...keywordCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5);

const proposals = [];
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
    why: `${incidents.length} incidents observed, prioritize recovery and rollback diagnostics`,
    confidence: 0.81
  });
}

if (proposals.length === 0) {
  proposals.push({
    title: "Expand gameplay depth",
    why: "No incidents and limited feedback signal; next safe expansion is wind+terrain modifiers",
    confidence: 0.55
  });
}

const lines = [
  "# Weekly Feature Proposals",
  `- Generated: ${new Date().toISOString()}`,
  "- Source: telemetry + feedback + incidents",
  ""
];

for (const proposal of proposals) {
  lines.push(`## ${proposal.title}`);
  lines.push(`- Why: ${proposal.why}`);
  lines.push(`- Confidence: ${(proposal.confidence * 100).toFixed(0)}%`);
  lines.push("");

  await appendLedgerEvent({
    type: "agent_event",
    action: "feature_proposed",
    actor: "learning_agent",
    metadata: {
      title: proposal.title,
      why: proposal.why,
      confidence: proposal.confidence
    }
  });
}

await mkdir(join(process.cwd(), "reports"), { recursive: true });
await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(`[feature-proposals] wrote ${outputPath}`);

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
