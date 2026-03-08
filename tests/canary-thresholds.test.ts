import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCanary } from "../apps/artillery-game/src/server/ledger.js";
import type { ProjectHealthResponse } from "@darkfactory/contracts";

function health(overrides?: Partial<ProjectHealthResponse["metrics"]>): ProjectHealthResponse {
  return {
    status: "ok",
    generatedAt: "2026-03-08T00:00:00.000Z",
    metrics: {
      matchesCreated: 0,
      matchesCompleted: 0,
      commandRejections: 0,
      disconnects: 0,
      completionRate: 0,
      ...overrides
    }
  };
}

test("canary ignores reject-rate when match count is below minimum sample threshold", () => {
  const snapshot = summarizeCanary(
    health({ matchesCreated: 2, commandRejections: 2, disconnects: 0 }),
    0.1,
    5,
    5
  );

  assert.equal(snapshot.pass, true);
  assert.equal(snapshot.metrics.rejectRate, 1);
});

test("canary enforces reject-rate when minimum sample threshold is reached", () => {
  const snapshot = summarizeCanary(
    health({ matchesCreated: 10, commandRejections: 3, disconnects: 0 }),
    0.1,
    5,
    5
  );

  assert.equal(snapshot.pass, false);
});
