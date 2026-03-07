import { test } from "node:test";
import assert from "node:assert/strict";
import { hashState } from "../apps/artillery-game/src/shared/determinism.js";
import { addPlayer, applyCommand, createInitialState, publicState } from "../apps/artillery-game/src/shared/simulation.js";
import type { CommandEnvelope } from "../apps/artillery-game/src/shared/types.js";

function playSequence(seed: number): string {
  let state = addPlayer(createInitialState("match-a", seed, "2026-03-07T00:00:00.000Z"), "p1", "Player 1");
  state = addPlayer(state, "p2", "Player 2", "2026-03-07T00:00:01.000Z");

  const commands: CommandEnvelope[] = [
    {
      commandId: "c-1",
      playerId: "p1",
      issuedAt: "2026-03-07T00:01:00.000Z",
      body: { type: "aim", angle: 40 }
    },
    {
      commandId: "c-2",
      playerId: "p1",
      issuedAt: "2026-03-07T00:01:01.000Z",
      body: { type: "power", power: 26 }
    },
    {
      commandId: "c-3",
      playerId: "p2",
      issuedAt: "2026-03-07T00:01:02.000Z",
      body: { type: "ready" }
    },
    {
      commandId: "c-4",
      playerId: "p1",
      issuedAt: "2026-03-07T00:01:03.000Z",
      body: { type: "fire" }
    },
    {
      commandId: "c-5",
      playerId: "p1",
      issuedAt: "2026-03-07T00:01:04.000Z",
      body: { type: "ready" }
    },
    {
      commandId: "c-6",
      playerId: "p2",
      issuedAt: "2026-03-07T00:01:05.000Z",
      body: { type: "ready" }
    },
    {
      commandId: "c-7",
      playerId: "p2",
      issuedAt: "2026-03-07T00:01:06.000Z",
      body: { type: "fire" }
    }
  ];

  for (const command of commands) {
    const result = applyCommand(state, command, command.issuedAt);
    assert.equal(result.rejected, undefined, `command ${command.commandId} should not be rejected`);
    state = result.state;
  }

  return hashState(publicState(state));
}

test("replay with same seed and command sequence yields identical hash", () => {
  const hashOne = playSequence(42_4242);
  const hashTwo = playSequence(42_4242);
  assert.equal(hashOne, hashTwo);
});
