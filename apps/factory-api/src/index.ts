import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type {
  AgentQualityStatus,
  ArchitectureTaskRequest,
  CloudEventEnvelope,
  FactoryAdminStatus,
  FactoryEventsQuery,
  ImplementationTaskRequest
} from "@darkfactory/contracts";
import { createArtilleryAdapter } from "@darkfactory/project-adapter-artillery";
import {
  createArchitectureProvider,
  enqueueApprovedSpecsForArchitecture,
  processArchitectureQueue
} from "./architecture.js";
import { createCodexProvider, enqueueAcceptedSpecs, processImplementationQueue } from "./implementation.js";
import { createFactoryStore } from "./storage.js";

export interface FactoryApiServer {
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
  port(): number;
}

export async function createFactoryApiServer(): Promise<FactoryApiServer> {
  const store = await createFactoryStore();
  const server = createServer(async (request, response) => {
    try {
      await route(request, response, store);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      await writeJson(response, 500, { error: message });
    }
  });

  return {
    listen: async (port: number, host = "127.0.0.1") => {
      await new Promise<void>((resolve) => server.listen(port, host, resolve));
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    port: () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        return 0;
      }
      return address.port;
    }
  };
}

async function route(request: IncomingMessage, response: ServerResponse, store: Awaited<ReturnType<typeof createFactoryStore>>): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/") {
    await redirect(response, "/dashboard");
    return;
  }

  if (method === "GET" && url.pathname === "/dashboard") {
    const [factory, agents, deployments, architectureTasks, implementationTasks] = await Promise.all([
      store.getFactoryStatus(),
      store.getAgentStatus(),
      store.getDeployments(25),
      store.listArchitectureTasks(),
      store.listImplementationTasks()
    ]);
    const architectureDetails = await Promise.all(architectureTasks.slice(0, 25).map(async (task) => ({
      task,
      run: task.runId ? await store.getArchitectureRun(task.runId) : null,
      artifact: task.runId ? await store.getArchitectureArtifact(task.runId) : null
    })));
    const taskDetails = await Promise.all(implementationTasks.slice(0, 25).map(async (task) => ({
      task,
      planningRun: task.planId ? await store.findImplementationPlanArtifactBySpecId(task.specId).then((plan) => plan?.runId ? store.getImplementationPlanningRun(plan.runId) : null) : null,
      plan: task.planId ? await store.findImplementationPlanArtifactBySpecId(task.specId) : null,
      run: task.runId ? await store.getImplementationRun(task.runId) : null,
      artifact: task.runId ? await store.getImplementationArtifact(task.runId) : null
    })));

    await writeHtml(response, 200, renderDashboard(factory, agents, deployments, architectureDetails, taskDetails));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/health") {
    await writeJson(response, 200, { status: "ok", generatedAt: new Date().toISOString() });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/admin/factory") {
    await writeJson(response, 200, await store.getFactoryStatus());
    return;
  }

  if (method === "GET" && url.pathname === "/v1/admin/events") {
    const query: FactoryEventsQuery = {
      type: asType(url.searchParams.get("type")),
      action: asString(url.searchParams.get("action")),
      specId: asString(url.searchParams.get("specId")),
      deployId: asString(url.searchParams.get("deployId")),
      matchId: asString(url.searchParams.get("matchId")),
      after: asString(url.searchParams.get("after")),
      order: asOrder(url.searchParams.get("order")),
      limit: asNumber(url.searchParams.get("limit"))
    };
    await writeJson(response, 200, { events: await store.getEvents(query) });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/admin/agents") {
    await writeJson(response, 200, await store.getAgentStatus());
    return;
  }

  if (method === "GET" && url.pathname === "/v1/admin/deployments") {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    await writeJson(response, 200, { deployments: await store.getDeployments(Number.isFinite(limit) ? limit : 20) });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/admin/project-health") {
    await writeJson(response, 200, await store.getProjectHealth());
    return;
  }

  if (method === "POST" && url.pathname === "/v1/admin/project/canary") {
    await writeJson(response, 200, await store.getProjectCanary());
    return;
  }

  const verifyMatch = url.pathname.match(/^\/v1\/admin\/project\/scenarios\/([^/]+)\/verify$/);
  if (method === "POST" && verifyMatch) {
    await writeJson(response, 200, await store.verifyScenario(decodeURIComponent(verifyMatch[1] ?? "")));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/admin/implementation/tasks") {
    const body = await readJson<ImplementationTaskRequest>(request);
    await writeJson(response, 200, await store.enqueueImplementationTask(body));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/admin/implementation/tasks") {
    await writeJson(response, 200, { tasks: await store.listImplementationTasks() });
    return;
  }

  const taskMatch = url.pathname.match(/^\/v1\/admin\/implementation\/tasks\/([^/]+)$/);
  if (method === "GET" && taskMatch) {
    const task = await store.getImplementationTask(decodeURIComponent(taskMatch[1] ?? ""));
    await writeJson(response, task ? 200 : 404, task ?? { error: "Not found" });
    return;
  }

  const cancelMatch = url.pathname.match(/^\/v1\/admin\/implementation\/tasks\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    const task = await store.getImplementationTask(decodeURIComponent(cancelMatch[1] ?? ""));
    if (!task) {
      await writeJson(response, 404, { error: "Not found" });
      return;
    }
    task.status = "aborted";
    task.updatedAt = new Date().toISOString();
    await store.writeImplementationTask(task);
    await writeJson(response, 200, task);
    return;
  }

  const retryMatch = url.pathname.match(/^\/v1\/admin\/implementation\/tasks\/([^/]+)\/retry$/);
  if (method === "POST" && retryMatch) {
    const task = await store.getImplementationTask(decodeURIComponent(retryMatch[1] ?? ""));
    if (!task) {
      await writeJson(response, 404, { error: "Not found" });
      return;
    }
    task.status = "queued";
    task.runId = undefined;
    task.blockedReason = undefined;
    task.failedReason = undefined;
    task.attempt += 1;
    task.updatedAt = new Date().toISOString();
    await store.writeImplementationTask(task);
    await writeJson(response, 200, task);
    return;
  }

  const runMatch = url.pathname.match(/^\/v1\/admin\/implementation\/runs\/([^/]+)$/);
  if (method === "GET" && runMatch) {
    const runId = decodeURIComponent(runMatch[1] ?? "");
    const [run, artifact] = await Promise.all([
      store.getImplementationRun(runId),
      store.getImplementationArtifact(runId)
    ]);
    if (!run) {
      await writeJson(response, 404, { error: "Not found" });
      return;
    }
    await writeJson(response, 200, { run, artifact });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/admin/implementation/drain") {
    const adapter = createArtilleryAdapter();
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    const [owner, repo] = repository.split("/");
    const provider = createCodexProvider(owner, repo);
    const processed = await processImplementationQueue(store, adapter, provider, {
      actor: process.env.FACTORY_ACTOR ?? "implementation_worker",
      source: process.env.FACTORY_SOURCE ?? "darkfactory.implementation",
      deployId: process.env.DEPLOY_ID,
      repoFullName: repository,
      owner,
      repo,
      baseBranch: process.env.GITHUB_REF_NAME ?? "main",
      baseSha: process.env.GITHUB_SHA ?? ""
    });
    await writeJson(response, 200, { tasks: processed });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/admin/implementation/enqueue-accepted") {
    const adapter = createArtilleryAdapter();
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    const [owner, repo] = repository.split("/");
    const queued = await enqueueAcceptedSpecs(store, adapter, {
      actor: process.env.FACTORY_ACTOR ?? "implementation_worker",
      source: process.env.FACTORY_SOURCE ?? "darkfactory.implementation",
      deployId: process.env.DEPLOY_ID,
      repoFullName: repository,
      owner,
      repo,
      baseBranch: process.env.GITHUB_REF_NAME ?? "main",
      baseSha: process.env.GITHUB_SHA ?? "",
      reportRootDir: process.cwd()
    });
    await writeJson(response, 200, { tasks: queued });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/admin/architecture/tasks") {
    const body = await readJson<ArchitectureTaskRequest>(request);
    await writeJson(response, 200, await store.enqueueArchitectureTask(body));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/admin/architecture/tasks") {
    await writeJson(response, 200, { tasks: await store.listArchitectureTasks() });
    return;
  }

  const architectureTaskMatch = url.pathname.match(/^\/v1\/admin\/architecture\/tasks\/([^/]+)$/);
  if (method === "GET" && architectureTaskMatch) {
    const task = await store.getArchitectureTask(decodeURIComponent(architectureTaskMatch[1] ?? ""));
    await writeJson(response, task ? 200 : 404, task ?? { error: "Not found" });
    return;
  }

  const architectureCancelMatch = url.pathname.match(/^\/v1\/admin\/architecture\/tasks\/([^/]+)\/cancel$/);
  if (method === "POST" && architectureCancelMatch) {
    const task = await store.getArchitectureTask(decodeURIComponent(architectureCancelMatch[1] ?? ""));
    if (!task) {
      await writeJson(response, 404, { error: "Not found" });
      return;
    }
    task.status = "aborted";
    task.updatedAt = new Date().toISOString();
    await store.writeArchitectureTask(task);
    await writeJson(response, 200, task);
    return;
  }

  const architectureRetryMatch = url.pathname.match(/^\/v1\/admin\/architecture\/tasks\/([^/]+)\/retry$/);
  if (method === "POST" && architectureRetryMatch) {
    const task = await store.getArchitectureTask(decodeURIComponent(architectureRetryMatch[1] ?? ""));
    if (!task) {
      await writeJson(response, 404, { error: "Not found" });
      return;
    }
    task.status = "queued";
    task.runId = undefined;
    task.blockedReason = undefined;
    task.failedReason = undefined;
    task.attempt += 1;
    task.updatedAt = new Date().toISOString();
    await store.writeArchitectureTask(task);
    await writeJson(response, 200, task);
    return;
  }

  const architectureRunMatch = url.pathname.match(/^\/v1\/admin\/architecture\/runs\/([^/]+)$/);
  if (method === "GET" && architectureRunMatch) {
    const runId = decodeURIComponent(architectureRunMatch[1] ?? "");
    const [run, artifact] = await Promise.all([
      store.getArchitectureRun(runId),
      store.getArchitectureArtifact(runId)
    ]);
    if (!run) {
      await writeJson(response, 404, { error: "Not found" });
      return;
    }
    await writeJson(response, 200, { run, artifact });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/admin/architecture/drain") {
    const adapter = createArtilleryAdapter();
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    const [owner, repo] = repository.split("/");
    const provider = createArchitectureProvider(owner, repo);
    const processed = await processArchitectureQueue(store, adapter, provider, {
      actor: process.env.FACTORY_ACTOR ?? "architecture_worker",
      source: process.env.FACTORY_SOURCE ?? "darkfactory.architecture",
      deployId: process.env.DEPLOY_ID,
      repoFullName: repository,
      owner,
      repo,
      baseBranch: process.env.GITHUB_REF_NAME ?? "main",
      baseSha: process.env.GITHUB_SHA ?? "",
      reportRootDir: process.cwd()
    });
    await writeJson(response, 200, { tasks: processed });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/admin/architecture/enqueue-approved") {
    const adapter = createArtilleryAdapter();
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    const [owner, repo] = repository.split("/");
    const queued = await enqueueApprovedSpecsForArchitecture(store, adapter, {
      actor: process.env.FACTORY_ACTOR ?? "architecture_worker",
      source: process.env.FACTORY_SOURCE ?? "darkfactory.architecture",
      deployId: process.env.DEPLOY_ID,
      repoFullName: repository,
      owner,
      repo,
      baseBranch: process.env.GITHUB_REF_NAME ?? "main",
      baseSha: process.env.GITHUB_SHA ?? "",
      reportRootDir: process.cwd()
    });
    await writeJson(response, 200, { tasks: queued });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/events") {
    const body = await readJson<CloudEventEnvelope<Record<string, unknown>>>(request);
    validateCloudEvent(body);
    await store.ingest(body);
    await writeJson(response, 202, { ok: true });
    return;
  }

  await writeJson(response, 404, { error: "Not found" });
}

function validateCloudEvent(event: CloudEventEnvelope<Record<string, unknown>>): void {
  const required = ["specversion", "id", "source", "type", "time", "datacontenttype", "data"] as const;
  for (const key of required) {
    if (!(key in event)) {
      throw new Error(`Invalid CloudEvent: missing ${key}`);
    }
  }

  const data = event.data ?? {};
  for (const key of ["specId", "scenarioId", "deployId", "matchId", "action", "actor"]) {
    if (typeof data[key] !== "string") {
      throw new Error(`Invalid CloudEvent data: missing ${key}`);
    }
  }
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? (JSON.parse(raw) as T) : ({} as T);
}

async function writeJson(response: ServerResponse, status: number, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

async function writeHtml(response: ServerResponse, status: number, body: string): Promise<void> {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

async function redirect(response: ServerResponse, location: string): Promise<void> {
  response.writeHead(302, { Location: location });
  response.end();
}

function renderDashboard(
  factory: FactoryAdminStatus,
  agents: AgentQualityStatus,
  deployments: Array<Record<string, unknown>>,
  architectureDetails: Array<{
    task: Awaited<ReturnType<Awaited<ReturnType<typeof createFactoryStore>>["listArchitectureTasks"]>>[number];
    run: Awaited<ReturnType<Awaited<ReturnType<typeof createFactoryStore>>["getArchitectureRun"]>>;
    artifact: Awaited<ReturnType<Awaited<ReturnType<typeof createFactoryStore>>["getArchitectureArtifact"]>>;
  }>,
  taskDetails: Array<{
    task: Awaited<ReturnType<Awaited<ReturnType<typeof createFactoryStore>>["listImplementationTasks"]>>[number];
    planningRun: Awaited<ReturnType<Awaited<ReturnType<typeof createFactoryStore>>["getImplementationPlanningRun"]>> | null;
    plan: Awaited<ReturnType<Awaited<ReturnType<typeof createFactoryStore>>["findImplementationPlanArtifactBySpecId"]>> | null;
    run: Awaited<ReturnType<Awaited<ReturnType<typeof createFactoryStore>>["getImplementationRun"]>>;
    artifact: Awaited<ReturnType<Awaited<ReturnType<typeof createFactoryStore>>["getImplementationArtifact"]>>;
  }>
): string {
  const statusClass = factory.status === "ok" ? "ok" : "degraded";
  const deploymentRows = deployments.length > 0
    ? deployments.map((deployment) => {
      const at = escapeHtml(String(deployment.at ?? ""));
      const specId = escapeHtml(String(deployment.specId ?? ""));
      const deployId = escapeHtml(String(deployment.deployId ?? ""));
      const metadata = escapeHtml(JSON.stringify(deployment.metadata ?? {}));
      return `<tr><td>${at}</td><td>${specId}</td><td>${deployId}</td><td class="metadata">${metadata}</td></tr>`;
    }).join("")
    : `<tr><td colspan="4" class="empty">No deployments recorded.</td></tr>`;
  const taskRows = taskDetails.length > 0
    ? taskDetails.map(({ task, plan, planningRun, run }) => {
      const discovery = run?.discovery;
      const planningSelected = planningRun?.discovery?.selectedContextFiles ?? plan?.selectedContextFiles ?? [];
      const discoverySummary = discovery
        ? [
            `selected=${discovery.selectedContextFiles.length}`,
            `read=${discovery.readFiles.length}`,
            discovery.blockedReason ? `blocked=${discovery.blockedReason}` : ""
          ].filter(Boolean).join(" | ")
        : "";
      const selected = discovery?.selectedContextFiles?.slice(0, 5).join(", ") ?? "";
      const sliceSummary = task.sliceId ? `${task.sliceId} (${(task.sliceIndex ?? 0) + 1}/${task.totalSlices ?? 1})` : "plan";
      return `<tr><td>${escapeHtml(task.specId)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(task.provider ?? "")}</td><td>${escapeHtml(task.model ?? "")}</td><td>${escapeHtml(task.updatedAt)}</td><td class="metadata">${escapeHtml(sliceSummary)}</td><td class="metadata">${escapeHtml(discoverySummary)}</td><td class="metadata">${escapeHtml(planningSelected.slice(0, 5).join(", "))}</td><td class="metadata">${escapeHtml(selected)}</td></tr>`;
    }).join("")
    : `<tr><td colspan="9" class="empty">No implementation tasks recorded.</td></tr>`;
  const architectureRows = architectureDetails.length > 0
    ? architectureDetails.map(({ task, artifact, run }) => {
      const selected = Array.isArray(run?.metadata?.selectedContextFiles)
        ? String((run?.metadata?.selectedContextFiles as string[]).slice(0, 5).join(", "))
        : "";
      const invariants = Array.isArray(artifact?.payload?.invariants)
        ? String(artifact?.payload?.invariants.slice(0, 2).join(" | "))
        : "";
      return `<tr><td>${escapeHtml(task.specId)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(task.provider ?? "")}</td><td>${escapeHtml(task.updatedAt)}</td><td class="metadata">${escapeHtml(selected)}</td><td class="metadata">${escapeHtml(invariants)}</td></tr>`;
    }).join("")
    : `<tr><td colspan="6" class="empty">No architecture tasks recorded.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <title>Factory Dashboard</title>
  <style>
    :root { color-scheme: light; --bg: #f6f8fb; --card: #ffffff; --text: #142033; --muted: #4f6078; --ok: #166534; --warn: #92400e; --border: #d8e1ef; --accent: #1d4ed8; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; background: linear-gradient(180deg, #eef3ff, var(--bg)); color: var(--text); font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
    h1, h2 { margin: 0 0 12px; }
    p { margin: 0; color: var(--muted); }
    a { color: var(--accent); text-decoration: none; }
    .layout { max-width: 1120px; margin: 0 auto; display: grid; gap: 16px; }
    .header { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; flex-wrap: wrap; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px; box-shadow: 0 2px 10px rgba(20, 32, 51, 0.05); }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
    .value { font-size: 28px; font-weight: 700; line-height: 1.2; }
    .status { font-size: 14px; font-weight: 600; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border); }
    .status.ok { color: var(--ok); background: #ecfdf5; border-color: #bbf7d0; }
    .status.degraded { color: var(--warn); background: #fff7ed; border-color: #fdba74; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); vertical-align: top; font-size: 14px; }
    th { color: var(--muted); font-weight: 600; }
    .metadata { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--muted); }
    .empty { text-align: center; color: var(--muted); }
  </style>
</head>
<body>
  <div class="layout">
    <section class="header">
      <div>
        <h1>Factory Dashboard</h1>
        <p>Dark factory status, architecture pipeline, deployment history, and implementation worker health.</p>
      </div>
      <span class="status ${statusClass}">${escapeHtml(factory.status)}</span>
    </section>
    <section class="cards">
      <article class="card"><div class="label">Queued Specs</div><div class="value">${factory.pipeline.queuedSpecs}</div></article>
      <article class="card"><div class="label">Architecture Queue</div><div class="value">${factory.pipeline.architectureQueueDepth ?? 0}</div></article>
      <article class="card"><div class="label">Architected Today</div><div class="value">${factory.pipeline.architectureMergedToday ?? 0}</div></article>
      <article class="card"><div class="label">Architecture Blocked</div><div class="value">${factory.pipeline.architectureBlockedToday ?? 0}</div></article>
      <article class="card"><div class="label">Implementation Queue</div><div class="value">${factory.pipeline.implementationQueueDepth ?? 0}</div></article>
      <article class="card"><div class="label">Merged Tasks</div><div class="value">${factory.pipeline.implementationMergedToday ?? 0}</div></article>
      <article class="card"><div class="label">Blocked Tasks</div><div class="value">${factory.pipeline.implementationBlockedToday ?? 0}</div></article>
      <article class="card"><div class="label">Gate Failures</div><div class="value">${factory.pipeline.gateFailures}</div></article>
      <article class="card"><div class="label">Deployments Today</div><div class="value">${factory.pipeline.deploymentsToday}</div></article>
      <article class="card"><div class="label">Acceptance Rate</div><div class="value">${agents.acceptanceRate.toFixed(2)}</div></article>
      <article class="card"><div class="label">Regression Rate</div><div class="value">${agents.regressionRate.toFixed(2)}</div></article>
    </section>
    <section class="card"><h2>Recent Deployments</h2><table><thead><tr><th>At</th><th>Spec</th><th>Deploy</th><th>Metadata</th></tr></thead><tbody>${deploymentRows}</tbody></table></section>
    <section class="card"><h2>Architecture Tasks</h2><table><thead><tr><th>Spec</th><th>Status</th><th>Provider</th><th>Updated</th><th>Selected Files</th><th>Invariants</th></tr></thead><tbody>${architectureRows}</tbody></table></section>
    <section class="card"><h2>Implementation Tasks</h2><table><thead><tr><th>Spec</th><th>Status</th><th>Provider</th><th>Model</th><th>Updated</th><th>Slice</th><th>Discovery</th><th>Plan Files</th><th>Selected Files</th></tr></thead><tbody>${taskRows}</tbody></table></section>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function asType(value: string | null): FactoryEventsQuery["type"] | undefined {
  if (!value) {
    return undefined;
  }
  if (["game_event", "pipeline_event", "agent_event", "user_feedback", "incident"].includes(value)) {
    return value as FactoryEventsQuery["type"];
  }
  return undefined;
}

function asString(value: string | null): string | undefined {
  return value?.trim() || undefined;
}

function asOrder(value: string | null): FactoryEventsQuery["order"] | undefined {
  return value === "asc" || value === "desc" ? value : undefined;
}

function asNumber(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4174);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = await createFactoryApiServer();
  await server.listen(port, host);
  console.log(`[factory-api] listening on http://${host}:${port}`);
}
