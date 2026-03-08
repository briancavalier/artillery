import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createFactoryApiClient,
  isFactoryEventLocalMode,
  type CloudEventEnvelope,
  type FactoryEventsQuery,
  type FeatureSpec
} from "@darkfactory/contracts";
import type {
  CanarySnapshot,
  DeploymentRecord,
  EvaluationReport,
  FactoryAdapter,
  ScenarioEvidence,
  SpecRecord
} from "@darkfactory/core";

interface AdapterConfig {
  specDir: string;
  ledgerPath: string;
  evidenceDir: string;
  evaluationsDir: string;
  canaryPath: string;
  factoryApiBaseUrl?: string;
  localEventMode: boolean;
  stagingHook?: string;
  productionHook?: string;
  projectControlBaseUrl?: string;
  dryRun: boolean;
}

export function createArtilleryAdapter(overrides?: Partial<AdapterConfig>): FactoryAdapter {
  const config: AdapterConfig = {
    specDir: process.env.SPEC_DIR ?? join(process.cwd(), "specs"),
    ledgerPath: process.env.LEDGER_PATH ?? join(process.cwd(), "var/ledger/events.ndjson"),
    evidenceDir: process.env.EVIDENCE_DIR ?? join(process.cwd(), "evidence"),
    evaluationsDir: process.env.EVALUATIONS_DIR ?? join(process.cwd(), "reports/evaluations"),
    canaryPath: process.env.CANARY_PATH ?? join(process.cwd(), "ops/canary/latest.json"),
    factoryApiBaseUrl: process.env.FACTORY_API_BASE_URL,
    localEventMode: isFactoryEventLocalMode(),
    stagingHook: process.env.RENDER_STAGING_DEPLOY_HOOK,
    productionHook: process.env.RENDER_PROD_DEPLOY_HOOK,
    projectControlBaseUrl: process.env.PROJECT_CONTROL_BASE_URL,
    dryRun: process.env.DRY_RUN === "1",
    ...overrides
  };
  const eventClient = config.localEventMode
    ? null
    : createFactoryApiClient({ baseUrl: config.factoryApiBaseUrl, requireBaseUrl: true });

  return {
    listSpecs: async () => {
      await mkdir(config.specDir, { recursive: true });
      const entries = await readdir(config.specDir, { withFileTypes: true });
      const records: SpecRecord[] = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }

        const path = join(config.specDir, entry.name);
        const raw = await readFile(path, "utf8");
        records.push({ path, data: JSON.parse(raw) as FeatureSpec });
      }

      return records;
    },

    readSpecById: async (specId: string) => {
      const specs = await loadSpecs(config.specDir);
      return specs.find((record) => record.data.specId === specId) ?? null;
    },

    writeSpec: async (record: SpecRecord) => {
      if (config.dryRun) {
        return;
      }

      await mkdir(dirname(record.path), { recursive: true });
      await writeFile(record.path, `${JSON.stringify(record.data, null, 2)}\n`, "utf8");
    },

    appendEvent: async (event: CloudEventEnvelope<Record<string, unknown>>) => {
      if (config.dryRun) {
        return;
      }

      if (config.localEventMode) {
        await mkdir(dirname(config.ledgerPath), { recursive: true });
        await writeFile(config.ledgerPath, `${JSON.stringify(event)}\n`, {
          encoding: "utf8",
          flag: "a"
        });
        return;
      }

      await eventClient?.ingestEvent(event);
    },

    writeEvaluation: async (report: EvaluationReport) => {
      if (config.dryRun) {
        return;
      }

      const path = join(config.evaluationsDir, `${report.specId}.json`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    },

    readEvaluation: async (specId: string) => {
      const path = join(config.evaluationsDir, `${specId}.json`);
      try {
        const raw = await readFile(path, "utf8");
        return JSON.parse(raw) as EvaluationReport;
      } catch {
        return null;
      }
    },

    readScenarioEvidence: async (specId: string, scenarioId: string) => {
      const path = join(config.evidenceDir, specId, `${scenarioId}.json`);
      try {
        const raw = await readFile(path, "utf8");
        return JSON.parse(raw) as ScenarioEvidence;
      } catch {
        return null;
      }
    },

    readCanarySnapshot: async () => {
      try {
        const raw = await readFile(config.canaryPath, "utf8");
        return JSON.parse(raw) as CanarySnapshot;
      } catch {
        return null;
      }
    },

    deploy: async (environment: "staging" | "production", specId: string) => {
      const hook = environment === "staging" ? config.stagingHook : config.productionHook;
      const deployId = `${environment}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      const commitRef = resolveDeployCommitRef();

      if (config.dryRun || !hook) {
        return {
          environment,
          status: "ok",
          deployId,
          metadata: {
            mode: config.dryRun ? "dry-run" : "no-hook",
            specId,
            commitRef: commitRef ?? ""
          }
        } satisfies DeploymentRecord;
      }

      const hookUrl = addDeployRef(hook, commitRef);
      const response = await fetch(hookUrl, { method: "POST" });
      if (!response.ok) {
        return {
          environment,
          status: "failed",
          deployId,
          metadata: { statusCode: response.status, specId, commitRef: commitRef ?? "" }
        } satisfies DeploymentRecord;
      }

      return {
        environment,
        status: "ok",
        deployId,
        metadata: {
          specId,
          hookResponseStatus: response.status,
          commitRef: commitRef ?? ""
        }
      } satisfies DeploymentRecord;
    },

    rollback: async (specId: string, reason: string) => {
      if (config.dryRun) {
        return;
      }

      if (config.projectControlBaseUrl) {
        try {
          const baseUrl = normalizeBaseUrl(config.projectControlBaseUrl);
          await fetch(`${baseUrl}/v1/project/rollback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ specId, reason, requestId: randomUUID() })
          });
        } catch {
          // Rollback still recorded in events even if project endpoint is unavailable.
        }
      }
    }
  };
}

export async function readCloudEvents(
  ledgerPath = process.env.LEDGER_PATH ?? join(process.cwd(), "var/ledger/events.ndjson"),
  query: FactoryEventsQuery = {}
): Promise<Array<CloudEventEnvelope<Record<string, unknown>>>> {
  if (!isFactoryEventLocalMode()) {
    const client = createFactoryApiClient({ requireBaseUrl: true });
    return client.listEvents(query);
  }

  try {
    const raw = await readFile(ledgerPath, "utf8");
    return filterEvents(
      raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CloudEventEnvelope<Record<string, unknown>>),
      query
    );
  } catch {
    return [];
  }
}

async function loadSpecs(specDir: string): Promise<SpecRecord[]> {
  await mkdir(specDir, { recursive: true });
  const entries = await readdir(specDir, { withFileTypes: true });

  const specs: SpecRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const path = join(specDir, entry.name);
    const raw = await readFile(path, "utf8");
    specs.push({ path, data: JSON.parse(raw) as FeatureSpec });
  }

  return specs;
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

function resolveDeployCommitRef(): string | undefined {
  const value = process.env.FACTORY_COMMIT_SHA ?? process.env.GITHUB_SHA ?? process.env.COMMIT_SHA;
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function addDeployRef(hook: string, commitRef: string | undefined): string {
  if (!commitRef) {
    return hook;
  }

  try {
    const url = new URL(hook);
    url.searchParams.set("ref", commitRef);
    return url.toString();
  } catch {
    return hook;
  }
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

  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 5000);
  return filtered.slice(0, limit);
}
