import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashState } from "../../../apps/artillery-game/src/shared/determinism.js";
import { addPlayer, applyCommand, createInitialState, publicState } from "../../../apps/artillery-game/src/shared/simulation.js";
import type { CommandEnvelope } from "../../../apps/artillery-game/src/shared/types.js";
import { appendLedgerEvent, readLedger, verifyScenario } from "../../../apps/artillery-game/src/server/ledger.js";
import { MatchStore } from "../../../apps/artillery-game/src/server/match-store.js";
import type { FeatureSpec } from "@darkfactory/contracts";
import type { ScenarioEvidence } from "@darkfactory/core";

export interface ArtilleryEvidenceOptions {
  evidenceDir?: string;
  ledgerPath?: string;
  actor?: string;
  source?: string;
  deployId?: string;
}

export async function generateArtilleryScenarioEvidence(
  spec: FeatureSpec,
  options: ArtilleryEvidenceOptions = {}
): Promise<ScenarioEvidence[]> {
  const evidenceDir = options.evidenceDir ?? join(process.cwd(), "evidence");
  const ledgerPath = options.ledgerPath ?? join(tmpdir(), `artillery-evidence-${spec.specId}-${Date.now()}.ndjson`);
  const actor = options.actor ?? "spec_executor";
  const source = options.source ?? "darkfactory.execution";
  const deployId = options.deployId ?? `spec-execution-${Date.now()}`;

  const results: ScenarioEvidence[] = [];
  const requiredScenarios = spec.scenarios.filter((scenario) => scenario.required);
  for (const scenario of requiredScenarios) {
    const evidence = await executeScenario(spec, scenario.id, {
      evidenceDir,
      ledgerPath,
      actor,
      source,
      deployId
    });
    results.push(evidence);
  }

  return results;
}

async function executeScenario(
  spec: FeatureSpec,
  scenarioId: string,
  options: Required<ArtilleryEvidenceOptions>
): Promise<ScenarioEvidence> {
  await mkdir(join(options.evidenceDir, spec.specId), { recursive: true });

  const evidencePath = join(options.evidenceDir, spec.specId, `${scenarioId}.json`);
  const now = new Date().toISOString();

  let passed = false;
  let details: Record<string, unknown> = {};

  switch (scenarioId) {
    case "SCN-0001":
      details = await verifyMatchCreateAndJoin(spec, options);
      passed = details.passed === true;
      break;
    case "SCN-0002":
      details = await verifyTurnOwnership(spec, options);
      passed = details.passed === true;
      break;
    case "SCN-0003":
      details = await verifyDeterminism(spec, options);
      passed = details.passed === true;
      break;
    default:
      details = { passed: false, reason: "No project adapter verifier is implemented for this scenario yet." };
      passed = false;
      break;
  }

  const evidence = {
    scenarioId,
    passed,
    at: now,
    artifact: evidencePath,
    details
  };

  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return {
    scenarioId,
    passed,
    at: now,
    artifact: evidencePath
  };
}

async function verifyMatchCreateAndJoin(
  spec: FeatureSpec,
  options: Required<ArtilleryEvidenceOptions>
): Promise<Record<string, unknown>> {
  return withScenarioEnv(spec.specId, options.ledgerPath, options.deployId, async () => {
    const store = new MatchStore();
    const created = await store.createMatch("Alpha", 1337);
    await store.joinMatch(created.matchId, "Bravo");

    const events = await readLedger(options.ledgerPath);
    const verification = verifyScenario(events, "SCN-0001");
    return {
      ...verification.details,
      passed: verification.passed,
      matchId: created.matchId
    };
  });
}

async function verifyTurnOwnership(
  spec: FeatureSpec,
  options: Required<ArtilleryEvidenceOptions>
): Promise<Record<string, unknown>> {
  return withScenarioEnv(spec.specId, options.ledgerPath, options.deployId, async () => {
    const store = new MatchStore();
    const created = await store.createMatch("Alpha", 1337);
    const joined = await store.joinMatch(created.matchId, "Bravo");

    await store.submitCommand(created.matchId, makeCommand("cmd-accepted", created.playerId, { type: "aim", angle: 52 }));
    const rejected = await store.submitCommand(created.matchId, makeCommand("cmd-rejected", joined.playerId, { type: "fire" }));

    const events = await readLedger(options.ledgerPath);
    const verification = verifyScenario(events, "SCN-0002");
    return {
      ...verification.details,
      passed: verification.passed,
      rejection: rejected.rejected ?? ""
    };
  });
}

async function verifyDeterminism(
  spec: FeatureSpec,
  options: Required<ArtilleryEvidenceOptions>
): Promise<Record<string, unknown>> {
  return withScenarioEnv(spec.specId, options.ledgerPath, options.deployId, async () => {
    const first = runDeterministicReplay(424242);
    const second = runDeterministicReplay(424242);
    const passed = first.hash === second.hash;

    await appendLedgerEvent({
      type: "game_event",
      action: "determinism_verified",
      actor: options.actor,
      source: options.source,
      specId: spec.specId,
      scenarioId: "SCN-0003",
      deployId: options.deployId,
      matchId: first.matchId,
      metadata: { hash: first.hash, repeatHash: second.hash, commandCount: first.commandCount }
    }, options.ledgerPath);

    const events = await readLedger(options.ledgerPath);
    const verification = verifyScenario(events, "SCN-0003");
    return {
      ...verification.details,
      passed: passed && verification.passed,
      hash: first.hash,
      repeatHash: second.hash
    };
  });
}

function runDeterministicReplay(seed: number): { hash: string; commandCount: number; matchId: string } {
  const matchId = `match-${seed}`;
  const createdAt = "2026-03-08T00:00:00.000Z";
  let state = addPlayer(createInitialState(matchId, seed, createdAt), "p1", "Alpha", createdAt);
  state = addPlayer(state, "p2", "Bravo", createdAt);

  const commands: CommandEnvelope[] = [
    makeCommand("cmd-1", "p1", { type: "aim", angle: 51 }),
    makeCommand("cmd-2", "p2", { type: "ready" }),
    makeCommand("cmd-3", "p1", { type: "ready" }),
    makeCommand("cmd-4", "p1", { type: "fire" })
  ];

  for (const command of commands) {
    state = applyCommand(state, command, createdAt).state;
  }

  return {
    hash: hashState(publicState(state)),
    commandCount: commands.length,
    matchId
  };
}

function makeCommand(commandId: string, playerId: string, body: CommandEnvelope["body"]): CommandEnvelope {
  return {
    commandId,
    playerId,
    issuedAt: "2026-03-08T00:00:00.000Z",
    body
  };
}

async function withScenarioEnv<T>(
  specId: string,
  ledgerPath: string,
  deployId: string,
  task: () => Promise<T>
): Promise<T> {
  const previousSpecId = process.env.SPEC_ID;
  const previousLedgerPath = process.env.LEDGER_PATH;
  const previousEventMode = process.env.FACTORY_EVENT_MODE;
  const previousDeployId = process.env.DEPLOY_ID;

  process.env.SPEC_ID = specId;
  process.env.LEDGER_PATH = ledgerPath;
  process.env.FACTORY_EVENT_MODE = "local";
  process.env.DEPLOY_ID = deployId;

  try {
    await mkdir(dirname(ledgerPath), { recursive: true });
    return await task();
  } finally {
    restoreEnv("SPEC_ID", previousSpecId);
    restoreEnv("LEDGER_PATH", previousLedgerPath);
    restoreEnv("FACTORY_EVENT_MODE", previousEventMode);
    restoreEnv("DEPLOY_ID", previousDeployId);
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
