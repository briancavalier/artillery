import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createFactoryApiClient,
  isFactoryEventLocalMode,
  normalizeCloudEvent,
  summarizeCanary,
  summarizeProjectHealth,
  type CloudEventEnvelope
} from "@darkfactory/contracts";

const outPath = process.env.CANARY_PATH ?? join(process.cwd(), "ops/canary/latest.json");
const maxRejectRate = Number(process.env.CANARY_MAX_REJECT_RATE ?? 0.1);
const maxDisconnects = Number(process.env.CANARY_MAX_DISCONNECTS ?? 5);
const minMatches = Number(process.env.CANARY_MIN_MATCHES ?? 5);

let rejectRate = 0;
let disconnects = 0;
let matchesCreated = 0;
let source = "factory-api";
let endpointError = "";

try {
  if (isFactoryEventLocalMode()) {
    source = "ledger-local";
    const ledgerPath = process.env.LEDGER_PATH ?? join(process.cwd(), "var/ledger/events.ndjson");
    const events = await readLedger(ledgerPath);
    const health = summarizeProjectHealth(events);
    const canary = summarizeCanary(health, { maxRejectRate, maxDisconnects, minMatches });
    rejectRate = canary.metrics.rejectRate;
    disconnects = canary.metrics.disconnects;
    matchesCreated = health.metrics.matchesCreated;
  } else {
    const client = createFactoryApiClient({ requireBaseUrl: true });
    const [health, canary] = await Promise.all([
      client.getProjectHealth(),
      client.getProjectCanary()
    ]);
    rejectRate = Number(canary.metrics.rejectRate ?? 0);
    disconnects = Number(canary.metrics.disconnects ?? 0);
    matchesCreated = Number(health.metrics.matchesCreated ?? 0);
  }
} catch (error) {
  endpointError = error instanceof Error ? error.message : String(error);
  source = isFactoryEventLocalMode() ? "ledger-local-unavailable" : "factory-api-unavailable";
}

const endpointAvailable = !source.endsWith("-unavailable");
const enoughSamples = matchesCreated >= minMatches;
const rejectRatePass = !enoughSamples || rejectRate <= maxRejectRate;
const pass = endpointAvailable && rejectRatePass && disconnects <= maxDisconnects;
const snapshot = {
  generatedAt: new Date().toISOString(),
  pass,
  source,
  endpointError: endpointError || undefined,
  thresholds: {
    maxRejectRate,
    maxDisconnects,
    minMatches
  },
  metrics: {
    rejectRate,
    disconnects,
    matchesCreated,
    sampleEligible: enoughSamples
  }
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`[canary] ${pass ? "PASS" : "FAIL"} rejectRate=${rejectRate.toFixed(3)} disconnects=${disconnects}`);

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : ".";
}

async function readLedger(path: string): Promise<Array<CloudEventEnvelope<Record<string, unknown>>>> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line) as CloudEventEnvelope<Record<string, unknown>>;
        normalizeCloudEvent(parsed);
        return parsed;
      });
  } catch {
    return [];
  }
}
