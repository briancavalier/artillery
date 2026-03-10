import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "pg";
import {
  type ArchitectureArtifact,
  type ArchitectureRun,
  type ArchitectureTask,
  type ArchitectureTaskRequest,
  type ImplementationPlanArtifact,
  type ImplementationPlanningRun,
  isFactoryEventLocalMode,
  summarizeCanary,
  summarizeProjectHealth,
  verifyScenario,
  type AgentQualityStatus,
  type CloudEventEnvelope,
  type FactoryAdminStatus,
  type FactoryEventsQuery,
  type ImplementationArtifact,
  type ImplementationRun,
  type ImplementationTask,
  type ImplementationTaskRequest,
  type ProjectCanaryResponse,
  type ProjectHealthResponse,
  type ScenarioVerificationResponse
} from "@darkfactory/contracts";
import type { FactoryStorePort } from "@darkfactory/core";

export interface FactoryStore extends FactoryStorePort {
  init(): Promise<void>;
  ingest(event: CloudEventEnvelope<Record<string, unknown>>): Promise<void>;
  getEvents(query?: FactoryEventsQuery): Promise<Array<CloudEventEnvelope<Record<string, unknown>>>>;
  getFactoryStatus(): Promise<FactoryAdminStatus>;
  getAgentStatus(): Promise<AgentQualityStatus>;
  getProjectHealth(): Promise<ProjectHealthResponse>;
  getProjectCanary(): Promise<ProjectCanaryResponse>;
  verifyScenario(scenarioId: string): Promise<ScenarioVerificationResponse>;
  getDeployments(limit?: number): Promise<Array<Record<string, unknown>>>;
}

interface FileState {
  events: Array<CloudEventEnvelope<Record<string, unknown>>>;
  architectureTasks: ArchitectureTask[];
  architectureRuns: ArchitectureRun[];
  architectureArtifacts: ArchitectureArtifact[];
  implementationTasks: ImplementationTask[];
  implementationPlanningRuns: ImplementationPlanningRun[];
  implementationPlanArtifacts: ImplementationPlanArtifact[];
  implementationRuns: ImplementationRun[];
  implementationArtifacts: ImplementationArtifact[];
}

export async function createFactoryStore(): Promise<FactoryStore> {
  const databaseUrl = process.env.FACTORY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (databaseUrl && databaseUrl.startsWith("postgres")) {
    const store = new PostgresFactoryStore(databaseUrl);
    await store.init();
    return store;
  }

  if (isFactoryEventLocalMode()) {
    const path = process.env.FACTORY_STATE_PATH ?? join(process.cwd(), "var/factory/state.json");
    const store = new FileFactoryStore(path);
    await store.init();
    return store;
  }

  throw new Error("FACTORY_DATABASE_URL is required unless FACTORY_EVENT_MODE=local");
}

class FileFactoryStore implements FactoryStore {
  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await readFile(this.path, "utf8");
    } catch {
      await writeFile(this.path, `${JSON.stringify(emptyState(), null, 2)}\n`, "utf8");
    }
  }

  async ingest(event: CloudEventEnvelope<Record<string, unknown>>): Promise<void> {
    const state = await this.read();
    state.events.push(event);
    await this.write(state);
  }

  async getEvents(query: FactoryEventsQuery = {}): Promise<Array<CloudEventEnvelope<Record<string, unknown>>>> {
    return filterEvents((await this.read()).events, query);
  }

  async getFactoryStatus(): Promise<FactoryAdminStatus> {
    const state = await this.read();
    return summarizeFactory(state.events, state.architectureTasks, state.implementationTasks);
  }

  async getAgentStatus(): Promise<AgentQualityStatus> {
    const events = await this.getEvents({ limit: 5000, order: "desc" });
    return summarizeAgents(events);
  }

  async getProjectHealth(): Promise<ProjectHealthResponse> {
    const events = await this.getEvents({ type: "game_event", limit: 5000, order: "desc" });
    return summarizeProjectHealth(events);
  }

  async getProjectCanary(): Promise<ProjectCanaryResponse> {
    return summarizeCanary(await this.getProjectHealth());
  }

  async verifyScenario(scenarioId: string): Promise<ScenarioVerificationResponse> {
    const events = await this.getEvents({ type: "game_event", limit: 5000, order: "desc" });
    return verifyScenario(events, scenarioId);
  }

  async getDeployments(limit = 20): Promise<Array<Record<string, unknown>>> {
    const events = await this.getEvents({ type: "pipeline_event", action: "spec_deployed", limit, order: "desc" });
    return events.map((event) => ({
      id: event.id,
      at: event.time,
      specId: event.data.specId,
      deployId: event.data.deployId,
      metadata: event.data.metadata ?? {}
    }));
  }

  async enqueueArchitectureTask(payload: ArchitectureTaskRequest): Promise<ArchitectureTask> {
    const state = await this.read();
    const task: ArchitectureTask = {
      taskId: randomUUID(),
      specId: payload.specId,
      source: payload.source,
      owner: payload.owner,
      repo: payload.repo,
      baseBranch: payload.baseBranch,
      baseSha: payload.baseSha,
      targetBranch: payload.targetBranch,
      artifactRoot: payload.artifactRoot,
      contextBundleRef: payload.contextBundleRef,
      attempt: 0,
      priority: payload.priority,
      limits: payload.limits,
      policy: payload.policy,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.architectureTasks.push(task);
    await this.write(state);
    return task;
  }

  async listArchitectureTasks(): Promise<ArchitectureTask[]> {
    const state = await this.read();
    return [...state.architectureTasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getArchitectureTask(taskId: string): Promise<ArchitectureTask | null> {
    const state = await this.read();
    return state.architectureTasks.find((task) => task.taskId === taskId) ?? null;
  }

  async findArchitectureTaskBySpecId(specId: string): Promise<ArchitectureTask | null> {
    const state = await this.read();
    return [...state.architectureTasks]
      .filter((task) => task.specId === specId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }

  async leaseArchitectureTask(): Promise<ArchitectureTask | null> {
    const state = await this.read();
    const task = state.architectureTasks
      .filter((entry) => entry.status === "queued")
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt.localeCompare(b.createdAt);
      })[0];

    if (!task) {
      return null;
    }

    task.status = "running";
    task.updatedAt = new Date().toISOString();
    await this.write(state);
    return structuredClone(task);
  }

  async writeArchitectureTask(task: ArchitectureTask): Promise<void> {
    const state = await this.read();
    const index = state.architectureTasks.findIndex((entry) => entry.taskId === task.taskId);
    if (index >= 0) {
      state.architectureTasks[index] = structuredClone(task);
    } else {
      state.architectureTasks.push(structuredClone(task));
    }
    await this.write(state);
  }

  async writeArchitectureRun(run: ArchitectureRun): Promise<void> {
    const state = await this.read();
    const index = state.architectureRuns.findIndex((entry) => entry.runId === run.runId);
    if (index >= 0) {
      state.architectureRuns[index] = structuredClone(run);
    } else {
      state.architectureRuns.push(structuredClone(run));
    }
    await this.write(state);
  }

  async getArchitectureRun(runId: string): Promise<ArchitectureRun | null> {
    const state = await this.read();
    return state.architectureRuns.find((run) => run.runId === runId) ?? null;
  }

  async writeArchitectureArtifact(artifact: ArchitectureArtifact): Promise<void> {
    const state = await this.read();
    const index = state.architectureArtifacts.findIndex((entry) => entry.runId === artifact.runId);
    if (index >= 0) {
      state.architectureArtifacts[index] = structuredClone(artifact);
    } else {
      state.architectureArtifacts.push(structuredClone(artifact));
    }
    await this.write(state);
  }

  async getArchitectureArtifact(runId: string): Promise<ArchitectureArtifact | null> {
    const state = await this.read();
    return state.architectureArtifacts.find((artifact) => artifact.runId === runId) ?? null;
  }

  async enqueueImplementationTask(payload: ImplementationTaskRequest): Promise<ImplementationTask> {
    const state = await this.read();
    const task: ImplementationTask = {
      taskId: randomUUID(),
      specId: payload.specId,
      source: payload.source,
      owner: payload.owner,
      repo: payload.repo,
      baseBranch: payload.baseBranch,
      baseSha: payload.baseSha,
      targetBranch: payload.targetBranch,
      allowedPaths: payload.allowedPaths,
      verificationTargets: payload.verificationTargets,
      contextBundleRef: payload.contextBundleRef,
      attempt: 0,
      priority: payload.priority,
      limits: payload.limits,
      policy: payload.policy,
      planId: payload.planId,
      sliceId: payload.sliceId,
      sliceIndex: payload.sliceIndex,
      totalSlices: payload.totalSlices,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.implementationTasks.push(task);
    await this.write(state);
    return task;
  }

  async listImplementationTasks(): Promise<ImplementationTask[]> {
    const state = await this.read();
    return [...state.implementationTasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getImplementationTask(taskId: string): Promise<ImplementationTask | null> {
    const state = await this.read();
    return state.implementationTasks.find((task) => task.taskId === taskId) ?? null;
  }

  async findImplementationTaskBySpecId(specId: string): Promise<ImplementationTask | null> {
    const state = await this.read();
    return [...state.implementationTasks]
      .filter((task) => task.specId === specId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }

  async leaseImplementationTask(): Promise<ImplementationTask | null> {
    const state = await this.read();
    const task = state.implementationTasks
      .filter((entry) => entry.status === "queued")
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt.localeCompare(b.createdAt);
      })[0];

    if (!task) {
      return null;
    }

    task.status = "running";
    task.updatedAt = new Date().toISOString();
    await this.write(state);
    return structuredClone(task);
  }

  async writeImplementationTask(task: ImplementationTask): Promise<void> {
    const state = await this.read();
    const index = state.implementationTasks.findIndex((entry) => entry.taskId === task.taskId);
    if (index >= 0) {
      state.implementationTasks[index] = structuredClone(task);
    } else {
      state.implementationTasks.push(structuredClone(task));
    }
    await this.write(state);
  }

  async writeImplementationPlanningRun(run: ImplementationPlanningRun): Promise<void> {
    const state = await this.read();
    const index = state.implementationPlanningRuns.findIndex((entry) => entry.runId === run.runId);
    if (index >= 0) {
      state.implementationPlanningRuns[index] = structuredClone(run);
    } else {
      state.implementationPlanningRuns.push(structuredClone(run));
    }
    await this.write(state);
  }

  async getImplementationPlanningRun(runId: string): Promise<ImplementationPlanningRun | null> {
    const state = await this.read();
    return state.implementationPlanningRuns.find((run) => run.runId === runId) ?? null;
  }

  async writeImplementationPlanArtifact(artifact: ImplementationPlanArtifact): Promise<void> {
    const state = await this.read();
    const index = state.implementationPlanArtifacts.findIndex((entry) => entry.planId === artifact.planId);
    if (index >= 0) {
      state.implementationPlanArtifacts[index] = structuredClone(artifact);
    } else {
      state.implementationPlanArtifacts.push(structuredClone(artifact));
    }
    await this.write(state);
  }

  async getImplementationPlanArtifact(runId: string): Promise<ImplementationPlanArtifact | null> {
    const state = await this.read();
    return state.implementationPlanArtifacts.find((artifact) => artifact.runId === runId) ?? null;
  }

  async findImplementationPlanArtifactBySpecId(specId: string): Promise<ImplementationPlanArtifact | null> {
    const state = await this.read();
    return [...state.implementationPlanArtifacts]
      .filter((artifact) => artifact.specId === specId)
      .sort((a, b) => String(b.metadata?.updatedAt ?? "").localeCompare(String(a.metadata?.updatedAt ?? "")) || b.planId.localeCompare(a.planId))[0] ?? null;
  }

  async writeImplementationRun(run: ImplementationRun): Promise<void> {
    const state = await this.read();
    const index = state.implementationRuns.findIndex((entry) => entry.runId === run.runId);
    if (index >= 0) {
      state.implementationRuns[index] = structuredClone(run);
    } else {
      state.implementationRuns.push(structuredClone(run));
    }
    await this.write(state);
  }

  async getImplementationRun(runId: string): Promise<ImplementationRun | null> {
    const state = await this.read();
    return state.implementationRuns.find((run) => run.runId === runId) ?? null;
  }

  async writeImplementationArtifact(artifact: ImplementationArtifact): Promise<void> {
    const state = await this.read();
    const index = state.implementationArtifacts.findIndex((entry) => entry.runId === artifact.runId);
    if (index >= 0) {
      state.implementationArtifacts[index] = structuredClone(artifact);
    } else {
      state.implementationArtifacts.push(structuredClone(artifact));
    }
    await this.write(state);
  }

  async getImplementationArtifact(runId: string): Promise<ImplementationArtifact | null> {
    const state = await this.read();
    return state.implementationArtifacts.find((artifact) => artifact.runId === runId) ?? null;
  }

  private async read(): Promise<FileState> {
    const raw = await readFile(this.path, "utf8");
    const parsed = JSON.parse(raw) as Partial<FileState>;
    return {
      events: parsed.events ?? [],
      architectureTasks: parsed.architectureTasks ?? [],
      architectureRuns: parsed.architectureRuns ?? [],
      architectureArtifacts: parsed.architectureArtifacts ?? [],
      implementationTasks: parsed.implementationTasks ?? [],
      implementationPlanningRuns: parsed.implementationPlanningRuns ?? [],
      implementationPlanArtifacts: parsed.implementationPlanArtifacts ?? [],
      implementationRuns: parsed.implementationRuns ?? [],
      implementationArtifacts: parsed.implementationArtifacts ?? []
    };
  }

  private async write(state: FileState): Promise<void> {
    await writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS architecture_tasks (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS architecture_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS architecture_artifacts (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS implementation_tasks (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS implementation_planning_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS implementation_plan_artifacts (
        plan_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        spec_id TEXT NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS implementation_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      )
    `);
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS implementation_artifacts (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
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

  async getEvents(query: FactoryEventsQuery = {}): Promise<Array<CloudEventEnvelope<Record<string, unknown>>>> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (query.type) {
      values.push(query.type);
      conditions.push(`event_type = $${values.length}`);
    }
    if (query.action) {
      values.push(query.action);
      conditions.push(`payload->'data'->>'action' = $${values.length}`);
    }
    if (query.specId) {
      values.push(query.specId);
      conditions.push(`payload->'data'->>'specId' = $${values.length}`);
    }
    if (query.deployId) {
      values.push(query.deployId);
      conditions.push(`payload->'data'->>'deployId' = $${values.length}`);
    }
    if (query.matchId) {
      values.push(query.matchId);
      conditions.push(`payload->'data'->>'matchId' = $${values.length}`);
    }
    if (query.after) {
      values.push(query.after);
      conditions.push(`event_time > $${values.length}::timestamptz`);
    }

    values.push(clampLimit(query.limit));
    const limitPlaceholder = `$${values.length}`;
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = query.order === "asc" ? "ASC" : "DESC";
    const result = await this.client.query(
      `SELECT payload
         FROM factory_events
         ${whereClause}
        ORDER BY event_time ${order}
        LIMIT ${limitPlaceholder}`,
      values
    );

    return result.rows.map((row: { payload: unknown }) => row.payload as CloudEventEnvelope<Record<string, unknown>>);
  }

  async getFactoryStatus(): Promise<FactoryAdminStatus> {
    const [events, architectureTasks, implementationTasks] = await Promise.all([
      this.getEvents({ limit: 5000, order: "desc" }),
      this.listArchitectureTasks(),
      this.listImplementationTasks()
    ]);
    return summarizeFactory(events, architectureTasks, implementationTasks);
  }

  async getAgentStatus(): Promise<AgentQualityStatus> {
    const events = await this.getEvents({ limit: 5000, order: "desc" });
    return summarizeAgents(events);
  }

  async getProjectHealth(): Promise<ProjectHealthResponse> {
    const events = await this.getEvents({ type: "game_event", limit: 5000, order: "desc" });
    return summarizeProjectHealth(events);
  }

  async getProjectCanary(): Promise<ProjectCanaryResponse> {
    return summarizeCanary(await this.getProjectHealth());
  }

  async verifyScenario(scenarioId: string): Promise<ScenarioVerificationResponse> {
    const events = await this.getEvents({ type: "game_event", limit: 5000, order: "desc" });
    return verifyScenario(events, scenarioId);
  }

  async getDeployments(limit = 20): Promise<Array<Record<string, unknown>>> {
    const events = await this.getEvents({ type: "pipeline_event", action: "spec_deployed", limit, order: "desc" });
    return events.map((event) => ({
      id: event.id,
      at: event.time,
      specId: event.data.specId,
      deployId: event.data.deployId,
      metadata: event.data.metadata ?? {}
    }));
  }

  async enqueueArchitectureTask(payload: ArchitectureTaskRequest): Promise<ArchitectureTask> {
    const task: ArchitectureTask = {
      taskId: randomUUID(),
      specId: payload.specId,
      source: payload.source,
      owner: payload.owner,
      repo: payload.repo,
      baseBranch: payload.baseBranch,
      baseSha: payload.baseSha,
      targetBranch: payload.targetBranch,
      artifactRoot: payload.artifactRoot,
      contextBundleRef: payload.contextBundleRef,
      attempt: 0,
      priority: payload.priority,
      limits: payload.limits,
      policy: payload.policy,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.writeArchitectureTask(task);
    return task;
  }

  async listArchitectureTasks(): Promise<ArchitectureTask[]> {
    const result = await this.client.query(`SELECT payload FROM architecture_tasks ORDER BY updated_at DESC`);
    return result.rows.map((row) => row.payload as ArchitectureTask);
  }

  async getArchitectureTask(taskId: string): Promise<ArchitectureTask | null> {
    const result = await this.client.query(`SELECT payload FROM architecture_tasks WHERE id = $1 LIMIT 1`, [taskId]);
    return (result.rows[0]?.payload as ArchitectureTask | undefined) ?? null;
  }

  async findArchitectureTaskBySpecId(specId: string): Promise<ArchitectureTask | null> {
    const result = await this.client.query(
      `SELECT payload FROM architecture_tasks WHERE spec_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [specId]
    );
    return (result.rows[0]?.payload as ArchitectureTask | undefined) ?? null;
  }

  async leaseArchitectureTask(): Promise<ArchitectureTask | null> {
    const result = await this.client.query(
      `SELECT payload FROM architecture_tasks
       WHERE status = 'queued'
       ORDER BY (payload->>'priority')::int DESC, (payload->>'createdAt') ASC
       LIMIT 1`
    );
    const task = result.rows[0]?.payload as ArchitectureTask | undefined;
    if (!task) {
      return null;
    }
    task.status = "running";
    task.updatedAt = new Date().toISOString();
    await this.writeArchitectureTask(task);
    return task;
  }

  async writeArchitectureTask(task: ArchitectureTask): Promise<void> {
    await this.client.query(
      `INSERT INTO architecture_tasks (id, spec_id, status, updated_at, payload)
       VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET spec_id = EXCLUDED.spec_id, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, payload = EXCLUDED.payload`,
      [task.taskId, task.specId, task.status, task.updatedAt, JSON.stringify(task)]
    );
  }

  async writeArchitectureRun(run: ArchitectureRun): Promise<void> {
    const updatedAt = run.finishedAt ?? run.startedAt;
    await this.client.query(
      `INSERT INTO architecture_runs (id, task_id, status, updated_at, payload)
       VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET task_id = EXCLUDED.task_id, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, payload = EXCLUDED.payload`,
      [run.runId, run.taskId, run.status, updatedAt, JSON.stringify(run)]
    );
  }

  async getArchitectureRun(runId: string): Promise<ArchitectureRun | null> {
    const result = await this.client.query(`SELECT payload FROM architecture_runs WHERE id = $1 LIMIT 1`, [runId]);
    return (result.rows[0]?.payload as ArchitectureRun | undefined) ?? null;
  }

  async writeArchitectureArtifact(artifact: ArchitectureArtifact): Promise<void> {
    await this.client.query(
      `INSERT INTO architecture_artifacts (run_id, task_id, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (run_id) DO UPDATE SET task_id = EXCLUDED.task_id, payload = EXCLUDED.payload`,
      [artifact.runId, artifact.taskId, JSON.stringify(artifact)]
    );
  }

  async getArchitectureArtifact(runId: string): Promise<ArchitectureArtifact | null> {
    const result = await this.client.query(`SELECT payload FROM architecture_artifacts WHERE run_id = $1 LIMIT 1`, [runId]);
    return (result.rows[0]?.payload as ArchitectureArtifact | undefined) ?? null;
  }

  async enqueueImplementationTask(payload: ImplementationTaskRequest): Promise<ImplementationTask> {
    const task: ImplementationTask = {
      taskId: randomUUID(),
      specId: payload.specId,
      source: payload.source,
      owner: payload.owner,
      repo: payload.repo,
      baseBranch: payload.baseBranch,
      baseSha: payload.baseSha,
      targetBranch: payload.targetBranch,
      allowedPaths: payload.allowedPaths,
      verificationTargets: payload.verificationTargets,
      contextBundleRef: payload.contextBundleRef,
      attempt: 0,
      priority: payload.priority,
      limits: payload.limits,
      policy: payload.policy,
      planId: payload.planId,
      sliceId: payload.sliceId,
      sliceIndex: payload.sliceIndex,
      totalSlices: payload.totalSlices,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.writeImplementationTask(task);
    return task;
  }

  async listImplementationTasks(): Promise<ImplementationTask[]> {
    const result = await this.client.query(
      `SELECT payload FROM implementation_tasks ORDER BY updated_at DESC LIMIT 500`
    );
    return result.rows.map((row: { payload: ImplementationTask }) => row.payload);
  }

  async getImplementationTask(taskId: string): Promise<ImplementationTask | null> {
    const result = await this.client.query(
      `SELECT payload FROM implementation_tasks WHERE id = $1 LIMIT 1`,
      [taskId]
    );
    return (result.rows[0]?.payload as ImplementationTask | undefined) ?? null;
  }

  async findImplementationTaskBySpecId(specId: string): Promise<ImplementationTask | null> {
    const result = await this.client.query(
      `SELECT payload FROM implementation_tasks WHERE spec_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [specId]
    );
    return (result.rows[0]?.payload as ImplementationTask | undefined) ?? null;
  }

  async leaseImplementationTask(): Promise<ImplementationTask | null> {
    const result = await this.client.query(
      `SELECT payload FROM implementation_tasks WHERE status = 'queued' ORDER BY updated_at ASC LIMIT 1`
    );
    const task = result.rows[0]?.payload as ImplementationTask | undefined;
    if (!task) {
      return null;
    }
    task.status = "running";
    task.updatedAt = new Date().toISOString();
    await this.writeImplementationTask(task);
    return task;
  }

  async writeImplementationTask(task: ImplementationTask): Promise<void> {
    await this.client.query(
      `INSERT INTO implementation_tasks (id, spec_id, status, updated_at, payload)
       VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET spec_id = EXCLUDED.spec_id, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, payload = EXCLUDED.payload`,
      [task.taskId, task.specId, task.status, task.updatedAt, JSON.stringify(task)]
    );
  }

  async writeImplementationPlanningRun(run: ImplementationPlanningRun): Promise<void> {
    await this.client.query(
      `INSERT INTO implementation_planning_runs (id, task_id, status, updated_at, payload)
       VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET task_id = EXCLUDED.task_id, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, payload = EXCLUDED.payload`,
      [run.runId, run.taskId, run.status, run.finishedAt ?? run.startedAt, JSON.stringify(run)]
    );
  }

  async getImplementationPlanningRun(runId: string): Promise<ImplementationPlanningRun | null> {
    const result = await this.client.query(`SELECT payload FROM implementation_planning_runs WHERE id = $1 LIMIT 1`, [runId]);
    return (result.rows[0]?.payload as ImplementationPlanningRun | undefined) ?? null;
  }

  async writeImplementationPlanArtifact(artifact: ImplementationPlanArtifact): Promise<void> {
    await this.client.query(
      `INSERT INTO implementation_plan_artifacts (plan_id, run_id, task_id, spec_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (plan_id) DO UPDATE SET run_id = EXCLUDED.run_id, task_id = EXCLUDED.task_id, spec_id = EXCLUDED.spec_id, payload = EXCLUDED.payload`,
      [artifact.planId, artifact.runId, artifact.taskId, artifact.specId, JSON.stringify(artifact)]
    );
  }

  async getImplementationPlanArtifact(runId: string): Promise<ImplementationPlanArtifact | null> {
    const result = await this.client.query(`SELECT payload FROM implementation_plan_artifacts WHERE run_id = $1 LIMIT 1`, [runId]);
    return (result.rows[0]?.payload as ImplementationPlanArtifact | undefined) ?? null;
  }

  async findImplementationPlanArtifactBySpecId(specId: string): Promise<ImplementationPlanArtifact | null> {
    const result = await this.client.query(
      `SELECT payload FROM implementation_plan_artifacts WHERE spec_id = $1 ORDER BY run_id DESC LIMIT 1`,
      [specId]
    );
    return (result.rows[0]?.payload as ImplementationPlanArtifact | undefined) ?? null;
  }

  async writeImplementationRun(run: ImplementationRun): Promise<void> {
    await this.client.query(
      `INSERT INTO implementation_runs (id, task_id, status, updated_at, payload)
       VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET task_id = EXCLUDED.task_id, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, payload = EXCLUDED.payload`,
      [run.runId, run.taskId, run.status, run.finishedAt ?? run.startedAt, JSON.stringify(run)]
    );
  }

  async getImplementationRun(runId: string): Promise<ImplementationRun | null> {
    const result = await this.client.query(`SELECT payload FROM implementation_runs WHERE id = $1 LIMIT 1`, [runId]);
    return (result.rows[0]?.payload as ImplementationRun | undefined) ?? null;
  }

  async writeImplementationArtifact(artifact: ImplementationArtifact): Promise<void> {
    await this.client.query(
      `INSERT INTO implementation_artifacts (run_id, task_id, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (run_id) DO UPDATE SET task_id = EXCLUDED.task_id, payload = EXCLUDED.payload`,
      [artifact.runId, artifact.taskId, JSON.stringify(artifact)]
    );
  }

  async getImplementationArtifact(runId: string): Promise<ImplementationArtifact | null> {
    const result = await this.client.query(`SELECT payload FROM implementation_artifacts WHERE run_id = $1 LIMIT 1`, [runId]);
    return (result.rows[0]?.payload as ImplementationArtifact | undefined) ?? null;
  }
}

function summarizeFactory(
  events: Array<CloudEventEnvelope<Record<string, unknown>>>,
  architectureTasks: ArchitectureTask[],
  implementationTasks: ImplementationTask[]
): FactoryAdminStatus {
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
      rollbacksToday: rollbacks,
      architectureQueueDepth: architectureTasks.filter((task) => ["queued", "running"].includes(task.status)).length,
      architectureMergedToday: architectureTasks.filter((task) => task.status === "merged").length,
      architectureBlockedToday: architectureTasks.filter((task) => task.status === "blocked").length,
      implementationQueueDepth: implementationTasks.filter((task) => ["queued", "running", "merge_ready"].includes(task.status)).length,
      implementationMergedToday: implementationTasks.filter((task) => task.status === "merged").length,
      implementationBlockedToday: implementationTasks.filter((task) => task.status === "blocked").length
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

function clampLimit(limit?: number): number {
  const normalized = Number(limit ?? 100);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return 100;
  }
  return Math.min(Math.floor(normalized), 5000);
}

function filterEvents(
  events: Array<CloudEventEnvelope<Record<string, unknown>>>,
  query: FactoryEventsQuery
): Array<CloudEventEnvelope<Record<string, unknown>>> {
  const filtered = events.filter((event) => {
    const data = event.data as Record<string, unknown>;
    if (query.type && event.type !== query.type) {
      return false;
    }
    if (query.action && String(data.action ?? "") !== query.action) {
      return false;
    }
    if (query.specId && String(data.specId ?? "") !== query.specId) {
      return false;
    }
    if (query.deployId && String(data.deployId ?? "") !== query.deployId) {
      return false;
    }
    if (query.matchId && String(data.matchId ?? "") !== query.matchId) {
      return false;
    }
    if (query.after && String(event.time) <= query.after) {
      return false;
    }
    return true;
  });

  filtered.sort((left, right) => String(left.time).localeCompare(String(right.time)));
  if (query.order !== "asc") {
    filtered.reverse();
  }

  return filtered.slice(0, clampLimit(query.limit));
}

function emptyState(): FileState {
  return {
    events: [],
    architectureTasks: [],
    architectureRuns: [],
    architectureArtifacts: [],
    implementationTasks: [],
    implementationPlanningRuns: [],
    implementationPlanArtifacts: [],
    implementationRuns: [],
    implementationArtifacts: []
  };
}
