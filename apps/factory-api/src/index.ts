import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { CloudEventEnvelope } from "@darkfactory/contracts";
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
