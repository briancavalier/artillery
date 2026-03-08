import { test } from "node:test";
import assert from "node:assert/strict";
import { findLatestReasonForSpec, parseReasonDirective } from "../packages/factory-runner/src/spec-controller/reason-parser.js";

test("parseReasonDirective extracts specId and reason", () => {
  const parsed = parseReasonDirective("/factory-reason SPEC-0003: Terrain caused unfair spawns");
  assert.deepEqual(parsed, {
    specId: "SPEC-0003",
    reason: "Terrain caused unfair spawns"
  });
});

test("findLatestReasonForSpec returns latest actor-specific reason", () => {
  const reason = findLatestReasonForSpec(
    [
      {
        id: 1,
        body: "/factory-reason SPEC-0003: first",
        userLogin: "maintainer",
        createdAt: "2026-03-08T01:00:00.000Z"
      },
      {
        id: 2,
        body: "/factory-reason SPEC-0003: second",
        userLogin: "maintainer",
        createdAt: "2026-03-08T02:00:00.000Z"
      }
    ],
    "SPEC-0003",
    "maintainer"
  );

  assert.equal(reason, "second");
});
