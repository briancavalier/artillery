import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { AgentQualityStatus, CloudEventEnvelope, FactoryAdminStatus } from "@darkfactory/contracts";
import { createFactoryStore } from "./storage.js";

export interface FactoryApiServer {
  listen(port: number): Promise<void>;
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
    listen: async (port: number) => {
      await new Promise<void>((resolve) => server.listen(port, resolve));
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
    const [factory, agents, deployments] = await Promise.all([
      store.getFactoryStatus(),
      store.getAgentStatus(),
      store.getDeployments(25)
    ]);

    await writeHtml(response, 200, renderDashboard(factory, agents, deployments));
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

  if (method === "GET" && url.pathname === "/v1/admin/agents") {
    await writeJson(response, 200, await store.getAgentStatus());
    return;
  }

  if (method === "GET" && url.pathname === "/v1/admin/deployments") {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    await writeJson(response, 200, { deployments: await store.getDeployments(Number.isFinite(limit) ? limit : 20) });
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
  deployments: Array<Record<string, unknown>>
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <title>Factory Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8fb;
      --card: #ffffff;
      --text: #142033;
      --muted: #4f6078;
      --ok: #166534;
      --warn: #92400e;
      --border: #d8e1ef;
      --accent: #1d4ed8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: linear-gradient(180deg, #eef3ff, var(--bg));
      color: var(--text);
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    }
    h1, h2 { margin: 0 0 12px; }
    p { margin: 0; color: var(--muted); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .layout {
      max-width: 1120px;
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: baseline;
      flex-wrap: wrap;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 2px 10px rgba(20, 32, 51, 0.05);
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 4px;
    }
    .value {
      font-size: 28px;
      font-weight: 700;
      line-height: 1.2;
    }
    .status {
      font-size: 14px;
      font-weight: 600;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
    }
    .status.ok {
      color: var(--ok);
      background: #ecfdf5;
      border-color: #bbf7d0;
    }
    .status.degraded {
      color: var(--warn);
      background: #fff7ed;
      border-color: #fed7aa;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-size: 14px;
    }
    th, td {
      text-align: left;
      border-bottom: 1px solid var(--border);
      padding: 10px 8px;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .metadata {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-width: 420px;
      color: var(--muted);
      font-size: 12px;
    }
    .empty { color: var(--muted); }
    .links {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 8px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <main class="layout">
    <section class="header">
      <div>
        <h1>Dark Factory Dashboard</h1>
        <p>Auto-refreshes every 15 seconds. Generated at ${escapeHtml(factory.generatedAt)}.</p>
      </div>
      <div class="status ${statusClass}">Factory: ${escapeHtml(factory.status.toUpperCase())}</div>
    </section>

    <section class="cards">
      <article class="card">
        <div class="label">Queued Specs</div>
        <div class="value">${factory.pipeline.queuedSpecs}</div>
      </article>
      <article class="card">
        <div class="label">Gate Failures</div>
        <div class="value">${factory.pipeline.gateFailures}</div>
      </article>
      <article class="card">
        <div class="label">Deployments (Current Window)</div>
        <div class="value">${factory.pipeline.deploymentsToday}</div>
      </article>
      <article class="card">
        <div class="label">Rollbacks (Current Window)</div>
        <div class="value">${factory.pipeline.rollbacksToday}</div>
      </article>
    </section>

    <section class="cards">
      <article class="card">
        <div class="label">Agent Proposals</div>
        <div class="value">${agents.proposals}</div>
      </article>
      <article class="card">
        <div class="label">Accepted Proposals</div>
        <div class="value">${agents.acceptedProposals}</div>
      </article>
      <article class="card">
        <div class="label">Acceptance Rate</div>
        <div class="value">${formatPercent(agents.acceptanceRate)}</div>
      </article>
      <article class="card">
        <div class="label">Regression Rate</div>
        <div class="value">${formatPercent(agents.regressionRate)}</div>
      </article>
    </section>

    <section class="card">
      <h2>Recent Deployments</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Spec</th>
            <th>Deploy ID</th>
            <th>Metadata</th>
          </tr>
        </thead>
        <tbody>${deploymentRows}</tbody>
      </table>
      <div class="links">
        <a href="/v1/admin/factory">Factory JSON</a>
        <a href="/v1/admin/agents">Agent JSON</a>
        <a href="/v1/admin/deployments?limit=25">Deployments JSON</a>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createFactoryApiServer();
  const port = Number(process.env.FACTORY_API_PORT ?? process.env.PORT ?? 4174);
  await server.listen(port);
  console.log(`Factory API listening on http://127.0.0.1:${port}`);

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
