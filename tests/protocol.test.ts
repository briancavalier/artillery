import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as nodeRequest } from "node:http";
import { createArtilleryServer } from "../apps/artillery-game/src/server/http.js";

interface JsonResponse<T> {
  status: number;
  body: T;
}

test("HTTP+SSE protocol supports turn ownership, idempotency, and state snapshots", async () => {
  const ledgerPath = join(await mkdtemp(join(tmpdir(), "artillery-ledger-")), "events.ndjson");
  process.env.LEDGER_PATH = ledgerPath;

  const server = createArtilleryServer();
  await server.listen(0);
  const base = `http://127.0.0.1:${server.port()}`;

  try {
    const created = await post<{ matchId: string; playerId: string; state: { players: Array<{ id: string }> } }>(
      `${base}/v1/matches`,
      { ownerName: "Alpha", seed: 9001 }
    );
    assert.equal(created.status, 201);
    const ownerId = created.body.playerId;

    const matchId = created.body.matchId;
    const joined = await post<{ playerId: string }>(`${base}/v1/matches/${matchId}/join`, { playerName: "Bravo" });
    assert.equal(joined.status, 200);
    const joinedId = joined.body.playerId;

    const firstEvents = await readSse(`${base}/v1/matches/${matchId}/events`, 3);
    assert.ok(firstEvents.length >= 1);
    assert.ok(firstEvents[0]?.eventId >= 1);

    const wrongTurn = await post<{ rejected?: string }>(`${base}/v1/matches/${matchId}/commands`, {
      playerId: joinedId,
      command: { type: "fire" }
    });
    assert.equal(wrongTurn.status, 409);
    assert.equal(wrongTurn.body.rejected, "Not your turn");

    await post(`${base}/v1/matches/${matchId}/commands`, {
      playerId: joinedId,
      command: { type: "ready" }
    });

    const fireCommandId = "same-command";
    const firstFire = await post<{ state: { players: Array<{ id: string; health: number }> } }>(
      `${base}/v1/matches/${matchId}/commands`,
      {
        playerId: ownerId,
        commandId: fireCommandId,
        command: { type: "fire" }
      }
    );

    assert.equal(firstFire.status, 202);

    const afterFirst = await get<{ state: { players: Array<{ id: string; health: number }> } }>(`${base}/v1/matches/${matchId}/state`);

    const duplicateFire = await post<{ rejected?: string; state: { players: Array<{ id: string; health: number }> } }>(
      `${base}/v1/matches/${matchId}/commands`,
      {
        playerId: ownerId,
        commandId: fireCommandId,
        command: { type: "fire" }
      }
    );

    assert.equal(duplicateFire.status, 202);

    const afterDuplicate = await get<{ state: { players: Array<{ id: string; health: number }> } }>(`${base}/v1/matches/${matchId}/state`);
    assert.deepEqual(afterFirst.body.state.players, afterDuplicate.body.state.players, "duplicate command should not mutate state");
  } finally {
    await server.close();
    delete process.env.LEDGER_PATH;
  }
});

async function post<T>(url: string, payload: unknown): Promise<JsonResponse<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return {
    status: response.status,
    body: (await response.json()) as T
  };
}

async function get<T>(url: string): Promise<JsonResponse<T>> {
  const response = await fetch(url);
  return {
    status: response.status,
    body: (await response.json()) as T
  };
}

async function readSse(url: string, expectedEvents: number): Promise<Array<{ eventId: number; type: string }>> {
  return new Promise((resolve, reject) => {
    const events: Array<{ eventId: number; type: string }> = [];
    let buffer = "";
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        fail(new Error("Timed out waiting for SSE events"));
      }
    }, 3000);

    const finish = (value: Array<{ eventId: number; type: string }>): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      resolve(value);
    };

    const fail = (error: Error): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      reject(error);
    };

    const request = nodeRequest(url, { method: "GET", headers: { Accept: "text/event-stream" } }, (response) => {
      if (response.statusCode !== 200) {
        fail(new Error(`Unexpected SSE status: ${response.statusCode}`));
        return;
      }

      const contentType = response.headers["content-type"] ?? "";
      if (typeof contentType !== "string" || !contentType.includes("text/event-stream")) {
        fail(new Error(`Unexpected SSE content type: ${contentType}`));
        return;
      }

      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (finished) {
          return;
        }

        buffer += chunk;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const lines = frame.split("\n");
          const idLine = lines.find((line) => line.startsWith("id:"));
          const eventLine = lines.find((line) => line.startsWith("event:"));
          if (!idLine || !eventLine) {
            continue;
          }

          const eventId = Number(idLine.slice(3).trim());
          const type = eventLine.slice(6).trim();
          if (Number.isFinite(eventId)) {
            events.push({ eventId, type });
          }

          if (events.length >= expectedEvents) {
            request.destroy();
            finish(events);
            return;
          }
        }
      });

      response.on("error", (error) => {
        fail(error);
      });

      response.on("end", () => {
        finish(events);
      });
    });

    request.on("error", (error) => {
      fail(error);
    });

    request.end();
  });
}
