import type {
  CloudEventEnvelope,
  LedgerEventType,
  ProjectCanaryResponse,
  ProjectHealthResponse,
  ScenarioVerificationResponse
} from "./index.js";

export interface NormalizedCloudEvent {
  id: string;
  at: string;
  source: string;
  type: LedgerEventType;
  action: string;
  actor: string;
  specId: string;
  scenarioId: string;
  deployId: string;
  matchId: string;
  metadata: Record<string, unknown>;
}

export function normalizeCloudEvent(event: CloudEventEnvelope<Record<string, unknown>>): NormalizedCloudEvent {
  const data = event.data as Record<string, unknown>;
  return {
    id: String(event.id),
    at: String(event.time),
    source: String(event.source),
    type: event.type,
    action: String(data.action ?? "unknown_action"),
    actor: String(data.actor ?? "unknown_actor"),
    specId: String(data.specId ?? "SPEC-UNBOUND"),
    scenarioId: String(data.scenarioId ?? "SCN-UNBOUND"),
    deployId: String(data.deployId ?? "DEPLOY-UNBOUND"),
    matchId: String(data.matchId ?? "MATCH-UNBOUND"),
    metadata: asRecord(data.metadata)
  };
}

export function summarizeProjectHealth(
  events: Array<CloudEventEnvelope<Record<string, unknown>>>,
  generatedAt = new Date().toISOString()
): ProjectHealthResponse {
  const normalized = events.map(normalizeCloudEvent);
  const matchesCreated = count(normalized, "game_event", "match_created");
  const matchesCompleted = count(normalized, "game_event", "match_ended");
  const commandRejections = count(normalized, "game_event", "command_rejected");
  const disconnects = count(normalized, "game_event", "player_disconnected");

  return {
    status: commandRejections > 10 || disconnects > 10 ? "degraded" : "ok",
    generatedAt,
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
  options?: {
    generatedAt?: string;
    maxRejectRate?: number;
    maxDisconnects?: number;
    minMatches?: number;
  }
): ProjectCanaryResponse {
  const maxRejectRate = options?.maxRejectRate ?? Number(process.env.CANARY_MAX_REJECT_RATE ?? 0.1);
  const maxDisconnects = options?.maxDisconnects ?? Number(process.env.CANARY_MAX_DISCONNECTS ?? 5);
  const minMatches = options?.minMatches ?? Number(process.env.CANARY_MIN_MATCHES ?? 5);
  const rejectRate = health.metrics.matchesCreated > 0
    ? health.metrics.commandRejections / health.metrics.matchesCreated
    : 0;
  const enoughSamples = health.metrics.matchesCreated >= minMatches;
  const rejectRatePass = !enoughSamples || rejectRate <= maxRejectRate;

  return {
    generatedAt: options?.generatedAt ?? new Date().toISOString(),
    pass: rejectRatePass && health.metrics.disconnects <= maxDisconnects,
    metrics: {
      rejectRate,
      disconnects: health.metrics.disconnects
    }
  };
}

export function verifyScenario(
  events: Array<CloudEventEnvelope<Record<string, unknown>>>,
  scenarioId: string
): ScenarioVerificationResponse {
  const normalized = events.map(normalizeCloudEvent);

  switch (scenarioId) {
    case "SCN-0001": {
      const created = count(normalized, "game_event", "match_created");
      const joined = count(normalized, "game_event", "player_joined");
      return {
        scenarioId,
        passed: created > 0 && joined > 0,
        details: { created, joined }
      };
    }
    case "SCN-0002": {
      const rejected = count(normalized, "game_event", "command_rejected");
      const accepted = count(normalized, "game_event", "command_accepted");
      return {
        scenarioId,
        passed: rejected > 0 && accepted > 0,
        details: { rejected, accepted }
      };
    }
    case "SCN-0003": {
      const determinismChecks = normalized.filter((event) => event.action === "determinism_verified").length;
      return {
        scenarioId,
        passed: determinismChecks > 0,
        details: { determinismChecks }
      };
    }
    default:
      return {
        scenarioId,
        passed: false,
        details: { reason: "Unknown scenario id" }
      };
  }
}

function count(events: NormalizedCloudEvent[], type: LedgerEventType, action: string): number {
  return events.filter((event) => event.type === type && event.action === action).length;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
