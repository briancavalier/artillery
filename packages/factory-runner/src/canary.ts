import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const baseUrl = normalizeBaseUrl(process.env.PROJECT_CONTROL_BASE_URL ?? "http://127.0.0.1:4173");
const outPath = process.env.CANARY_PATH ?? join(process.cwd(), "ops/canary/latest.json");
const maxRejectRate = Number(process.env.CANARY_MAX_REJECT_RATE ?? 0.1);
const maxDisconnects = Number(process.env.CANARY_MAX_DISCONNECTS ?? 5);

let rejectRate = 0;
let disconnects = 0;
let source = "project-health";
let endpointError = "";
const explicitControlBaseUrl = process.env.PROJECT_CONTROL_BASE_URL?.trim().length ? true : false;

try {
  const response = await fetch(`${baseUrl}/v1/project/health`);
  if (!response.ok) {
    throw new Error(`status=${response.status}`);
  }

  const payload = await response.json() as {
    metrics?: {
      commandRejections?: number;
      matchesCreated?: number;
      disconnects?: number;
    }
  };

  const commandRejections = Number(payload.metrics?.commandRejections ?? 0);
  const matchesCreated = Number(payload.metrics?.matchesCreated ?? 0);
  disconnects = Number(payload.metrics?.disconnects ?? 0);
  rejectRate = matchesCreated > 0 ? commandRejections / matchesCreated : 0;
} catch (error) {
  endpointError = error instanceof Error ? error.message : String(error);
  if (explicitControlBaseUrl) {
    source = "project-health-unavailable";
  } else {
    source = "ledger-fallback";
    const ledgerPath = process.env.LEDGER_PATH ?? join(process.cwd(), "var/ledger/events.ndjson");
    const events = await readLedger(ledgerPath);
    const gameEvents = events.filter((event) => event.type === "game_event");
    const accepted = gameEvents.filter((event) => extractData(event).action === "command_accepted").length;
    const rejected = gameEvents.filter((event) => extractData(event).action === "command_rejected").length;
    disconnects = gameEvents.filter((event) => extractData(event).action === "player_disconnected").length;
    rejectRate = accepted + rejected > 0 ? rejected / (accepted + rejected) : 0;
  }
}

const endpointAvailable = source !== "project-health-unavailable";
const pass = endpointAvailable && rejectRate <= maxRejectRate && disconnects <= maxDisconnects;
const snapshot = {
  generatedAt: new Date().toISOString(),
  pass,
  source,
  endpointError: endpointError || undefined,
  thresholds: {
    maxRejectRate,
    maxDisconnects
  },
  metrics: {
    rejectRate,
    disconnects
  }
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`[canary] ${pass ? "PASS" : "FAIL"} rejectRate=${rejectRate.toFixed(3)} disconnects=${disconnects}`);

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : ".";
}

async function readLedger(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function extractData(event: Record<string, unknown>): Record<string, any> {
  if (event.data && typeof event.data === "object") {
    return event.data as Record<string, any>;
  }
  return event as Record<string, any>;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}
