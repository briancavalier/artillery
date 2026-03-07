import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const ledgerPath = process.env.LEDGER_PATH ?? join(process.cwd(), "var/ledger/events.ndjson");
const outPath = join(process.cwd(), "ops/canary/latest.json");

const maxRejectRate = Number(process.env.CANARY_MAX_REJECT_RATE ?? 0.1);
const maxDisconnects = Number(process.env.CANARY_MAX_DISCONNECTS ?? 5);

const events = await readLedger();
const gameEvents = events.filter((event) => event.type === "game_event");
const accepted = gameEvents.filter((event) => event.action === "command_accepted").length;
const rejected = gameEvents.filter((event) => event.action === "command_rejected").length;
const disconnects = gameEvents.filter((event) => event.action === "player_disconnected").length;

const rejectRate = accepted + rejected > 0 ? rejected / (accepted + rejected) : 0;
const pass = rejectRate <= maxRejectRate && disconnects <= maxDisconnects;

const snapshot = {
  generatedAt: new Date().toISOString(),
  pass,
  thresholds: {
    maxRejectRate,
    maxDisconnects
  },
  metrics: {
    accepted,
    rejected,
    rejectRate,
    disconnects
  }
};

await mkdir(join(process.cwd(), "ops/canary"), { recursive: true });
await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`[canary] ${pass ? "PASS" : "FAIL"} rejectRate=${rejectRate.toFixed(3)} disconnects=${disconnects}`);

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
