import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createFactoryApiClient,
  isFactoryEventLocalMode,
  normalizeCloudEvent,
  summarizeCanary as summarizeProjectCanaryFromHealth,
  summarizeProjectHealth as summarizeProjectHealthFromEvents,
  verifyScenario as verifyScenarioFromEvents,
  type CloudEventEnvelope,
  type ProjectHealthResponse,
  type ProjectCanaryResponse,
  type ScenarioVerificationResponse
} from "@darkfactory/contracts";

export interface LedgerEventInput {
  type: "game_event" | "pipeline_event" | "agent_event" | "user_feedback" | "incident";
  action: string;
  actor: string;
  metadata?: Record<string, unknown>;
  specId?: string;
  scenarioId?: string;
  deployId?: string;
  matchId?: string;
  id?: string;
  at?: string;
  source?: string;
}

export interface NormalizedLedgerEvent {
  id: string;
  at: string;
  type: LedgerEventInput["type"];
  action: string;
  actor: string;
  specId: string;
  scenarioId: string;
  deployId: string;
  matchId: string;
  metadata: Record<string, unknown>;
}

function defaultLedgerPath(): string {
  return process.env.LEDGER_PATH ?? "var/ledger/events.ndjson";
}

export async function appendLedgerEvent(input: LedgerEventInput, path = defaultLedgerPath()): Promise<NormalizedLedgerEvent> {
  const normalized = normalizeInput(input);
  const cloudEvent = toCloudEvent(normalized, input.source ?? "artillery.game");

  if (isFactoryEventLocalMode()) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(cloudEvent)}\n`, "utf8");
  } else {
    const client = createFactoryApiClient({ requireBaseUrl: false });
    void client.ingestEvent(cloudEvent, { failOpen: true }).catch(() => {
      // Telemetry must not block gameplay.
    });
  }

  return normalized;
}

export async function readLedger(path = defaultLedgerPath()): Promise<NormalizedLedgerEvent[]> {
  if (!isFactoryEventLocalMode()) {
    const client = createFactoryApiClient({ requireBaseUrl: true });
    const events = await client.listEvents({ type: "game_event", limit: 5000, order: "asc" });
    return events.map(fromCloudEvent);
  }

  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseLine(line))
      .filter((event): event is NormalizedLedgerEvent => event !== null);
  } catch {
    return [];
  }
}

export async function getProjectHealth(): Promise<ProjectHealthResponse> {
  if (!isFactoryEventLocalMode()) {
    const client = createFactoryApiClient({ requireBaseUrl: true });
    return client.getProjectHealth();
  }

  return summarizeProjectHealthFromEvents(await readCloudEvents());
}

export async function getProjectCanary(): Promise<ProjectCanaryResponse> {
  if (!isFactoryEventLocalMode()) {
    const client = createFactoryApiClient({ requireBaseUrl: true });
    return client.getProjectCanary();
  }

  return summarizeProjectCanaryFromHealth(await getProjectHealth());
}

export async function verifyProjectScenario(scenarioId: string): Promise<ScenarioVerificationResponse> {
  if (!isFactoryEventLocalMode()) {
    const client = createFactoryApiClient({ requireBaseUrl: true });
    return client.verifyScenario(scenarioId);
  }

  return verifyScenarioFromEvents(await readCloudEvents(), scenarioId);
}

export function summarizeProjectHealth(events: NormalizedLedgerEvent[]): ProjectHealthResponse {
  const matchesCreated = count(events, "game_event", "match_created");
  const matchesCompleted = count(events, "game_event", "match_ended");
  const commandRejections = count(events, "game_event", "command_rejected");
  const disconnects = count(events, "game_event", "player_disconnected");

  return {
    status: commandRejections > 10 || disconnects > 10 ? "degraded" : "ok",
    generatedAt: new Date().toISOString(),
    metrics: {
      matchesCreated,
      matchesCompleted,
      commandRejections,
      disconnects,
      completionRate: matchesCreated > 0 ? matchesCompleted / matchesCreated : 0
    }
  };
}

export function summarizeCanary(
  health: ProjectHealthResponse,
  maxRejectRate = Number(process.env.CANARY_MAX_REJECT_RATE ?? 0.1),
  maxDisconnects = Number(process.env.CANARY_MAX_DISCONNECTS ?? 5),
  minMatches = Number(process.env.CANARY_MIN_MATCHES ?? 5)
): ProjectCanaryResponse {
  const rejectRate = health.metrics.matchesCreated > 0
    ? health.metrics.commandRejections / health.metrics.matchesCreated
    : 0;
  const enoughSamples = health.metrics.matchesCreated >= minMatches;
  const rejectRatePass = !enoughSamples || rejectRate <= maxRejectRate;

  return {
    generatedAt: new Date().toISOString(),
    pass: rejectRatePass && health.metrics.disconnects <= maxDisconnects,
    metrics: {
      rejectRate,
      disconnects: health.metrics.disconnects
    }
  };
}

export function verifyScenario(events: NormalizedLedgerEvent[], scenarioId: string): {
  scenarioId: string;
  passed: boolean;
  details: Record<string, unknown>;
} {
  switch (scenarioId) {
    case "SCN-0001": {
      const created = count(events, "game_event", "match_created");
      const joined = count(events, "game_event", "player_joined");
      return {
        scenarioId,
        passed: created > 0 && joined > 0,
        details: { created, joined }
      };
    }
    case "SCN-0002": {
      const rejected = count(events, "game_event", "command_rejected");
      const accepted = count(events, "game_event", "command_accepted");
      return {
        scenarioId,
        passed: rejected > 0 && accepted > 0,
        details: { rejected, accepted }
      };
    }
    case "SCN-0003": {
      const determinismChecks = events.filter((event) => event.action === "determinism_verified").length;
      return {
        scenarioId,
        passed: determinismChecks > 0,
        details: { determinismChecks }
      };
    }
    default: {
      return {
        scenarioId,
        passed: false,
        details: { reason: "Unknown scenario id" }
      };
    }
  }
}

function toCloudEvent(
  event: NormalizedLedgerEvent,
  source: string
): CloudEventEnvelope<Record<string, unknown>> {
  return {
    specversion: "1.0",
    id: event.id,
    source,
    type: event.type,
    time: event.at,
    datacontenttype: "application/json",
    data: {
      action: event.action,
      actor: event.actor,
      specId: event.specId,
      scenarioId: event.scenarioId,
      deployId: event.deployId,
      matchId: event.matchId,
      metadata: event.metadata
    }
  };
}

function parseLine(line: string): NormalizedLedgerEvent | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;

    if (parsed.specversion === "1.0" && typeof parsed.type === "string" && parsed.data && typeof parsed.data === "object") {
      const data = parsed.data as Record<string, unknown>;
      return {
        id: String(parsed.id ?? randomUUID()),
        at: String(parsed.time ?? new Date().toISOString()),
        type: parsed.type as LedgerEventInput["type"],
        action: String(data.action ?? "unknown_action"),
        actor: String(data.actor ?? "unknown_actor"),
        specId: String(data.specId ?? "SPEC-UNBOUND"),
        scenarioId: String(data.scenarioId ?? "SCN-UNBOUND"),
        deployId: String(data.deployId ?? "DEPLOY-UNBOUND"),
        matchId: String(data.matchId ?? "MATCH-UNBOUND"),
        metadata: (data.metadata as Record<string, unknown>) ?? {}
      };
    }

    // Backward-compatible read path for previous local event format.
    return {
      id: String(parsed.id ?? randomUUID()),
      at: String(parsed.at ?? new Date().toISOString()),
      type: String(parsed.type ?? "incident") as LedgerEventInput["type"],
      action: String(parsed.action ?? "unknown_action"),
      actor: String(parsed.actor ?? "unknown_actor"),
      specId: String(parsed.specId ?? "SPEC-UNBOUND"),
      scenarioId: String(parsed.scenarioId ?? "SCN-UNBOUND"),
      deployId: String(parsed.deployId ?? "DEPLOY-UNBOUND"),
      matchId: String(parsed.matchId ?? "MATCH-UNBOUND"),
      metadata: (parsed.metadata as Record<string, unknown>) ?? {}
    };
  } catch {
    return null;
  }
}

function normalizeInput(input: LedgerEventInput): NormalizedLedgerEvent {
  return {
    id: input.id ?? randomUUID(),
    at: input.at ?? new Date().toISOString(),
    type: input.type,
    action: input.action,
    actor: input.actor,
    specId: input.specId ?? process.env.SPEC_ID ?? "SPEC-UNBOUND",
    scenarioId: input.scenarioId ?? "SCN-UNBOUND",
    deployId: input.deployId ?? process.env.DEPLOY_ID ?? "DEPLOY-UNBOUND",
    matchId: input.matchId ?? "MATCH-UNBOUND",
    metadata: input.metadata ?? {}
  };
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

function count(events: NormalizedLedgerEvent[], type: NormalizedLedgerEvent["type"], action: string): number {
  return events.filter((event) => event.type === type && event.action === action).length;
}

async function readCloudEvents(path = defaultLedgerPath()): Promise<Array<CloudEventEnvelope<Record<string, unknown>>>> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CloudEventEnvelope<Record<string, unknown>>);
  } catch {
    return [];
  }
}

function fromCloudEvent(event: CloudEventEnvelope<Record<string, unknown>>): NormalizedLedgerEvent {
  const normalized = normalizeCloudEvent(event);
  return {
    id: normalized.id,
    at: normalized.at,
    type: normalized.type,
    action: normalized.action,
    actor: normalized.actor,
    specId: normalized.specId,
    scenarioId: normalized.scenarioId,
    deployId: normalized.deployId,
    matchId: normalized.matchId,
    metadata: normalized.metadata
  };
}
