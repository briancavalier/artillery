import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFactoryApiClient, type CloudEventEnvelope } from "@darkfactory/contracts";

const inputPath = process.env.LEDGER_PATH ?? process.argv[2] ?? join(process.cwd(), "var/ledger/events.ndjson");
const client = createFactoryApiClient({ requireBaseUrl: true });

const raw = await readFile(inputPath, "utf8");
const events = raw
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line) as CloudEventEnvelope<Record<string, unknown>>);

for (const event of events) {
  await client.ingestEvent(event);
}

console.log(`[factory:backfill-events] ingested ${events.length} events from ${inputPath}`);
