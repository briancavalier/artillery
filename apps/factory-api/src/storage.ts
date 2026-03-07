import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "pg";
import type { CloudEventEnvelope, FactoryAdminStatus, AgentQualityStatus } from "@darkfactory/contracts";

export interface FactoryStore {
  init(): Promise<void>;
  ingest(event: CloudEventEnvelope<Record<string, unknown>>): Promise<void>;
  getFactoryStatus(): Promise<FactoryAdminStatus>;
  getAgentStatus(): Promise<AgentQualityStatus>;
  getDeployments(limit?: number): Promise<Array<Record<string, unknown>>>;
}

interface FileState {
  events: Array<CloudEventEnvelope<Record<string, unknown>>>;
}

export async function createFactoryStore(): Promise<FactoryStore> {
  const databaseUrl = process.env.FACTORY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (databaseUrl && databaseUrl.startsWith("postgres")) {
    const store = new PostgresFactoryStore(databaseUrl);
    await store.init();
    return store;
  }

  const path = process.env.FACTORY_STATE_PATH ?? join(process.cwd(), "var/factory/state.json");
  const store = new FileFactoryStore(path);
  await store.init();
  return store;
}

class FileFactoryStore implements FactoryStore {
  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await readFile(this.path, "utf8");
    } catch {
      await writeFile(this.path, `${JSON.stringify({ events: [] }, null, 2)}\n`, "utf8");
    }
  }

  async ingest(event: CloudEventEnvelope<Record<string, unknown>>): Promise<void> {
    const state = await this.read();
    state.events.push(event);
    await writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async getFactoryStatus(): Promise<FactoryAdminStatus> {
    const events = (await this.read()).events;
    return summarizeFactory(events);
  }

  async getAgentStatus(): Promise<AgentQualityStatus> {
    const events = (await this.read()).events;
    return summarizeAgents(events);
  }

  async getDeployments(limit = 20): Promise<Array<Record<string, unknown>>> {
    const events = (await this.read()).events;
    return events
      .filter((event) => event.type === "pipeline_event" && String(event.data.action) === "spec_deployed")
      .slice(-limit)
      .reverse()
      .map((event) => ({
        id: event.id,
        at: event.time,
        specId: event.data.specId,
        deployId: event.data.deployId,
        metadata: event.data.metadata ?? {}
      }));
  }

  private async read(): Promise<FileState> {
    const raw = await readFile(this.path, "utf8");
    return JSON.parse(raw) as FileState;
  }
}

class PostgresFactoryStore implements FactoryStore {
  private readonly client: Client;

  constructor(databaseUrl: string) {
    this.client = new Client({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.client.connect();
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS factory_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        event_time TIMESTAMPTZ NOT NULL,
        source TEXT NOT NULL,
        payload JSONB NOT NULL
      )
    `);
  }

  async ingest(event: CloudEventEnvelope<Record<string, unknown>>): Promise<void> {
    await this.client.query(
      `INSERT INTO factory_events (id, event_type, event_time, source, payload)
       VALUES ($1, $2, $3::timestamptz, $4, $5::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [event.id, event.type, event.time, event.source, JSON.stringify(event)]
    );
  }

  async getFactoryStatus(): Promise<FactoryAdminStatus> {
    const events = await this.recentEvents(5000);
    return summarizeFactory(events);
  }

  async getAgentStatus(): Promise<AgentQualityStatus> {
    const events = await this.recentEvents(5000);
    return summarizeAgents(events);
  }

  async getDeployments(limit = 20): Promise<Array<Record<string, unknown>>> {
    const result = await this.client.query(
      `SELECT payload
         FROM factory_events
        WHERE event_type = 'pipeline_event'
          AND payload->'data'->>'action' = 'spec_deployed'
        ORDER BY event_time DESC
        LIMIT $1`,
      [limit]
    );

    return result.rows.map((row: { payload: unknown }) => {
      const event = row.payload as CloudEventEnvelope<Record<string, unknown>>;
      return {
        id: event.id,
        at: event.time,
        specId: event.data.specId,
        deployId: event.data.deployId,
        metadata: event.data.metadata ?? {}
      };
    });
  }

  private async recentEvents(limit: number): Promise<Array<CloudEventEnvelope<Record<string, unknown>>>> {
    const result = await this.client.query(
      `SELECT payload
         FROM factory_events
        ORDER BY event_time DESC
        LIMIT $1`,
      [limit]
    );

    return result.rows.map((row: { payload: unknown }) => row.payload as CloudEventEnvelope<Record<string, unknown>>);
  }
}

function summarizeFactory(events: Array<CloudEventEnvelope<Record<string, unknown>>>): FactoryAdminStatus {
  const gateFailures = count(events, "pipeline_event", "gate_failed");
  const rollbacks = count(events, "pipeline_event", "spec_rollback");
  const deployments = count(events, "pipeline_event", "spec_deployed");
  const queued = events.filter((event) =>
    event.type === "pipeline_event" &&
    ["spec_critiqued", "spec_evaluated", "spec_refined", "spec_implemented"].includes(String(event.data.action))
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    status: gateFailures > 0 ? "degraded" : "ok",
    pipeline: {
      queuedSpecs: queued,
      gateFailures,
      deploymentsToday: deployments,
      rollbacksToday: rollbacks
    }
  };
}

function summarizeAgents(events: Array<CloudEventEnvelope<Record<string, unknown>>>): AgentQualityStatus {
  const proposals = count(events, "agent_event", "feature_proposed");
  const accepted = count(events, "agent_event", "proposal_accepted");
  const deployments = count(events, "pipeline_event", "spec_deployed");
  const rollbacks = count(events, "pipeline_event", "spec_rollback");

  return {
    generatedAt: new Date().toISOString(),
    proposals,
    acceptedProposals: accepted,
    acceptanceRate: proposals > 0 ? accepted / proposals : 0,
    regressionRate: deployments > 0 ? rollbacks / deployments : 0
  };
}

function count(events: Array<CloudEventEnvelope<Record<string, unknown>>>, type: string, action: string): number {
  return events.filter((event) => event.type === type && String(event.data.action) === action).length;
}
