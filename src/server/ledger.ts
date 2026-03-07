import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { LedgerEvent } from "../shared/types.js";

function defaultLedgerPath(): string {
  return process.env.LEDGER_PATH ?? "var/ledger/events.ndjson";
}

export interface LedgerEventInput {
  type: LedgerEvent["type"];
  action: string;
  actor: string;
  metadata?: Record<string, unknown>;
  specId?: string;
  scenarioId?: string;
  matchId?: string;
  id?: string;
  at?: string;
}

export async function appendLedgerEvent(input: LedgerEventInput, path = defaultLedgerPath()): Promise<LedgerEvent> {
  const event: LedgerEvent = {
    id: input.id ?? randomUUID(),
    at: input.at ?? new Date().toISOString(),
    type: input.type,
    action: input.action,
    actor: input.actor,
    specId: input.specId,
    scenarioId: input.scenarioId,
    matchId: input.matchId,
    metadata: input.metadata ?? {}
  };

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function readLedger(path = defaultLedgerPath()): Promise<LedgerEvent[]> {
  try {
    const data = await readFile(path, "utf8");
    return data
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LedgerEvent);
  } catch {
    return [];
  }
}

export interface HealthSnapshot {
  generatedAt: string;
  game: {
    matchesCreated: number;
    matchesCompleted: number;
    completionRate: number;
    disconnects: number;
    commandRejections: number;
  };
  factory: {
    specsAccepted: number;
    specsVetoed: number;
    rollbacks: number;
    gateFailures: number;
  };
  agents: {
    proposals: number;
    acceptedProposals: number;
    acceptanceRate: number;
  };
}

export function summarizeLedger(events: LedgerEvent[]): HealthSnapshot {
  const matchesCreated = countByAction(events, "game_event", "match_created");
  const matchesCompleted = countByAction(events, "game_event", "match_ended");
  const disconnects = countByAction(events, "game_event", "player_disconnected");
  const commandRejections = countByAction(events, "game_event", "command_rejected");
  const specsAccepted = countByAction(events, "pipeline_event", "spec_accepted");
  const specsVetoed = countByAction(events, "pipeline_event", "spec_vetoed");
  const rollbacks = countByAction(events, "pipeline_event", "spec_rollback");
  const gateFailures = countByAction(events, "pipeline_event", "gate_failed");
  const proposals = countByAction(events, "agent_event", "feature_proposed");
  const acceptedProposals = countByAction(events, "agent_event", "proposal_accepted");

  return {
    generatedAt: new Date().toISOString(),
    game: {
      matchesCreated,
      matchesCompleted,
      completionRate: matchesCreated > 0 ? matchesCompleted / matchesCreated : 0,
      disconnects,
      commandRejections
    },
    factory: {
      specsAccepted,
      specsVetoed,
      rollbacks,
      gateFailures
    },
    agents: {
      proposals,
      acceptedProposals,
      acceptanceRate: proposals > 0 ? acceptedProposals / proposals : 0
    }
  };
}

function countByAction(events: LedgerEvent[], type: LedgerEvent["type"], action: string): number {
  return events.filter((event) => event.type === type && event.action === action).length;
}
