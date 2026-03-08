import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatchStore } from "../apps/artillery-game/src/server/match-store.js";

test("match store preserves turn ownership, idempotency, and SSE snapshots", async () => {
  const ledgerPath = join(await mkdtemp(join(tmpdir(), "artillery-ledger-")), "events.ndjson");
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.LEDGER_PATH = ledgerPath;

  const store = new MatchStore();

  try {
    const created = await store.createMatch("Alpha", 9001);
    const ownerId = created.playerId;
    const matchId = created.matchId;

    const joined = await store.joinMatch(matchId, "Bravo");
    const joinedId = joined.playerId;

    const response = createFakeResponse();
    const subscription = store.subscribe(matchId, response as any);
    const firstEvents = parseSseFrames(response.writes.join(""));
    assert.ok(firstEvents.length >= 1);
    assert.ok(firstEvents[0]?.eventId >= 1);

    const wrongTurn = await store.submitCommand(matchId, {
      playerId: joinedId,
      commandId: "wrong-turn",
      issuedAt: new Date().toISOString(),
      body: { type: "fire" }
    });
    assert.equal(wrongTurn.rejected, "Not your turn");

    await store.submitCommand(matchId, {
      playerId: joinedId,
      commandId: "ready-command",
      issuedAt: new Date().toISOString(),
      body: { type: "ready" }
    });

    const fireCommandId = "same-command";
    const firstFire = await store.submitCommand(matchId, {
      playerId: ownerId,
      commandId: fireCommandId,
      issuedAt: new Date().toISOString(),
      body: { type: "fire" }
    });
    assert.equal(firstFire.rejected, undefined);

    const afterFirst = store.getState(matchId);
    const duplicateFire = await store.submitCommand(matchId, {
      playerId: ownerId,
      commandId: fireCommandId,
      issuedAt: new Date().toISOString(),
      body: { type: "fire" }
    });
    const afterDuplicate = store.getState(matchId);

    assert.deepEqual(afterFirst.players, afterDuplicate.players, "duplicate command should not mutate state");
    await subscription.close();
  } finally {
    delete process.env.FACTORY_EVENT_MODE;
    delete process.env.LEDGER_PATH;
  }
});

function createFakeResponse(): { writes: string[]; writableEnded: boolean; writeHead: () => void; write: (chunk: string) => void; end: () => void } {
  return {
    writes: [],
    writableEnded: false,
    writeHead: () => undefined,
    write(chunk: string) {
      this.writes.push(chunk);
    },
    end() {
      this.writableEnded = true;
    }
  };
}

function parseSseFrames(raw: string): Array<{ eventId: number; type: string }> {
  return raw
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split("\n");
      const idLine = lines.find((line) => line.startsWith("id:"));
      const eventLine = lines.find((line) => line.startsWith("event:"));
      return {
        eventId: Number(idLine?.slice(3).trim() ?? NaN),
        type: eventLine?.slice(6).trim() ?? ""
      };
    })
    .filter((frame) => Number.isFinite(frame.eventId) && frame.type.length > 0);
}
