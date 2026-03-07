import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MatchStore } from "./match-store.js";
import {
  appendLedgerEvent,
  readLedger,
  summarizeCanary,
  summarizeProjectHealth,
  verifyScenario
} from "./ledger.js";
import type { ClientCommand, CommandEnvelope } from "../shared/types.js";

export interface ArtilleryServer {
  listen: (port: number) => Promise<void>;
  close: () => Promise<void>;
  port: () => number;
}

export function createArtilleryServer(publicDir = join(process.cwd(), "dist/apps/artillery-game/public")): ArtilleryServer {
  const matchStore = new MatchStore();
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, matchStore, publicDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error";
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

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  matchStore: MatchStore,
  publicDir: string
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";

  if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    await serveFile(response, join(publicDir, "index.html"));
    return;
  }

  if (method === "GET" && url.pathname === "/client.js") {
    await serveFile(response, join(publicDir, "client.js"), "text/javascript; charset=utf-8");
    return;
  }

  if (method === "GET" && url.pathname === "/style.css") {
    await serveFile(response, join(publicDir, "style.css"), "text/css; charset=utf-8");
    return;
  }

  if (method === "GET" && url.pathname === "/v1/health") {
    const events = await readLedger();
    await writeJson(response, 200, summarizeProjectHealth(events));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/project/health") {
    const events = await readLedger();
    await writeJson(response, 200, summarizeProjectHealth(events));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/project/canary") {
    const events = await readLedger();
    const health = summarizeProjectHealth(events);
    await writeJson(response, 200, summarizeCanary(health));
    return;
  }

  const verifyMatch = url.pathname.match(/^\/v1\/project\/scenarios\/([^/]+)\/verify$/);
  if (method === "POST" && verifyMatch) {
    const [, scenarioId] = verifyMatch;
    const events = await readLedger();
    await writeJson(response, 200, verifyScenario(events, scenarioId));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/project/rollback") {
    const body = await readJsonBody<{ specId?: string; reason?: string; requestId?: string }>(request);
    await appendLedgerEvent({
      type: "incident",
      action: "project_rollback_requested",
      actor: "factory_plane",
      specId: body.specId,
      metadata: {
        reason: body.reason ?? "No reason supplied",
        requestId: body.requestId ?? randomUUID()
      }
    });
    await writeJson(response, 202, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/matches") {
    const body = await readJsonBody<{ ownerName?: string; seed?: number }>(request);
    const ownerName = body.ownerName?.trim() || "Player 1";
    const created = await matchStore.createMatch(ownerName, body.seed);
    await writeJson(response, 201, created);
    return;
  }

  const joinMatch = url.pathname.match(/^\/v1\/matches\/([^/]+)\/join$/);
  if (method === "POST" && joinMatch) {
    const [, matchId] = joinMatch;
    const body = await readJsonBody<{ playerName?: string }>(request);
    const playerName = body.playerName?.trim() || "Player 2";

    try {
      const joined = await matchStore.joinMatch(matchId, playerName);
      await writeJson(response, 200, joined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Join failed";
      await writeJson(response, 400, { error: message });
    }
    return;
  }

  const commandMatch = url.pathname.match(/^\/v1\/matches\/([^/]+)\/commands$/);
  if (method === "POST" && commandMatch) {
    const [, matchId] = commandMatch;
    const body = await readJsonBody<{ playerId?: string; commandId?: string; command?: ClientCommand }>(request);

    if (!body.playerId || !body.command) {
      await writeJson(response, 400, { error: "playerId and command are required" });
      return;
    }

    const envelope: CommandEnvelope = {
      playerId: body.playerId,
      commandId: body.commandId ?? randomUUID(),
      issuedAt: new Date().toISOString(),
      body: body.command
    };

    try {
      const result = await matchStore.submitCommand(matchId, envelope);
      await writeJson(response, result.rejected ? 409 : 202, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed";
      await writeJson(response, 400, { error: message });
    }
    return;
  }

  const stateMatch = url.pathname.match(/^\/v1\/matches\/([^/]+)\/state$/);
  if (method === "GET" && stateMatch) {
    const [, matchId] = stateMatch;

    try {
      await writeJson(response, 200, { state: matchStore.getState(matchId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "State failed";
      await writeJson(response, 404, { error: message });
    }
    return;
  }

  const streamMatch = url.pathname.match(/^\/v1\/matches\/([^/]+)\/events$/);
  if (method === "GET" && streamMatch) {
    const [, matchId] = streamMatch;
    const lastEventIdHeader = request.headers["last-event-id"];
    const lastEventId = typeof lastEventIdHeader === "string" ? Number(lastEventIdHeader) : undefined;

    try {
      const subscription = matchStore.subscribe(matchId, response, Number.isFinite(lastEventId) ? lastEventId : undefined);
      request.on("close", () => {
        void subscription.close();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stream failed";
      await writeJson(response, 404, { error: message });
    }
    return;
  }

  const feedbackMatch = url.pathname.match(/^\/v1\/matches\/([^/]+)\/feedback$/);
  if (method === "POST" && feedbackMatch) {
    const [, matchId] = feedbackMatch;
    const body = await readJsonBody<{ playerId?: string; message?: string }>(request);

    if (!body.playerId || !body.message) {
      await writeJson(response, 400, { error: "playerId and message are required" });
      return;
    }

    await matchStore.addFeedback(matchId, body.playerId, body.message);
    await writeJson(response, 202, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/incidents") {
    const body = await readJsonBody<{ action?: string; metadata?: Record<string, unknown>; specId?: string }>(request);
    await appendLedgerEvent({
      type: "incident",
      action: body.action ?? "incident_reported",
      actor: "maintainer",
      specId: body.specId,
      metadata: body.metadata ?? {}
    });

    await writeJson(response, 202, { ok: true });
    return;
  }

  await writeJson(response, 404, { error: "Not found" });
}

async function serveFile(response: ServerResponse, filePath: string, contentType = "text/html; charset=utf-8"): Promise<void> {
  try {
    await access(filePath);
  } catch {
    await writeJson(response, 404, { error: `Missing file: ${filePath}` });
    return;
  }

  response.writeHead(200, { "Content-Type": contentType });
  createReadStream(filePath).pipe(response);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body) as T;
}

async function writeJson(response: ServerResponse, status: number, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}
