# SPEC-0003 Architecture Overview

## Goals
- Upgrade terrain fidelity so every match starts on a natural-looking, high-resolution battlefield while guaranteeing fair, stable player spawns (SCN-0301).
- Preserve deterministic behaviour across simulation, replay, and verification when high-resolution terrain and crater mutations are involved (SCN-0302).
- Deliver smooth, localized deformation that players can reason about for subsequent shots (SCN-0303).
- Maintain fast match start and responsive turn loops under expected concurrency despite increased terrain work (SCN-0304).

## Current State
- `createInitialState` in `apps/artillery-game/src/shared/simulation.ts` generates a 64-sample array via a simple RNG loop; spawns are hard-coded at x=80 and x=560 without slope checks.
- Projectile resolution only adjusts player health; terrain remains static.
- Determinism relies on pure functions with seeded RNG, `hashState`, and replay tests (`tests/determinism.test.ts`).
- No dedicated instrumentation guards match start or turn processing latency.

## Proposed Data Model Changes
- Introduce a `TerrainSurface` structure stored on `MatchState.terrain`:
  ```ts
  interface TerrainSurface {
    sampleCount: number;            // e.g., 512
    spacing: number;                // world units per sample
    heights: number[];              // ground height per sample (integers)
    seed: number;                   // seed used for generation
    version: number;                // increments per deformation
    spawnSlots: Array<{
      x: number;                    // world coordinate
      sampleIndex: number;
      slope: number;                // absolute slope for stability checks
      occupiedBy?: string;          // playerId when assigned
    }>;
    metrics: {
      variationScore: number;       // normalized std-dev used to assert variety
      ridgeCount: number;
      valleyCount: number;
      flatPocketCount: number;
    };
  }
  ```
- Preserve `MatchState.terrain` as part of `publicState`; clients and evidence tooling consume the richer contract.

## Terrain Generation Pipeline (`shared/terrain/generator.ts`)
1. **Noise synthesis**: Use the existing xorshift RNG seeded from `MatchState.seed` to generate multi-octave noise (e.g., 4 octaves, persistence 0.55) for `sampleCount = 512` samples.
2. **Shape control**: Apply envelope curves (coarse ridge shaping + valley smoothing) to avoid monotonous slopes and to introduce prominent silhouettes.
3. **Normalization**: Clamp heights within `[groundMin, groundMax]` (e.g., 40–220 world units) and round to integers to keep deterministic hashing simple.
4. **Feature metrics**: Classify samples into ridge/valley/flat buckets via slope and curvature heuristics; compute `variationScore` and counts for verification gating.
5. **Spawn discovery**: Scan for contiguous windows meeting stability requirements (`slope <= 0.2`, clearance >= 16 world units) and record viable `spawnSlots`. Guarantee at least two slots by re-shaping locally if necessary.
6. Return a `TerrainSurface` plus RNG tail state. `createInitialState` stores the surface and carries forward the RNG state for wind.

## Spawn Placement (`simulation.ts`)
- Replace hard-coded x-positions with slot selection:
  - On `addPlayer`, pull the next unused `spawnSlots` entry, mark `occupiedBy`, and align player `x` to slot `x`.
  - If no slot exists (should not happen), fall back to deterministic default and log a ledger event for monitoring.
- When publishing `publicState`, include `terrain.spawnSlots` with `occupiedBy` redacted (`occupiedBy` replaced by boolean flags) to avoid leaking IDs if required.

## Terrain Deformation (`shared/terrain/crater.ts`)
- Provide `applyCrater(surface, impactX, options)` returning a new `heights` array and metadata:
  - Convert world `impactX` to sample index using `spacing`.
  - Affect samples within `radiusSamples` using a cubic falloff curve (C1 continuity) to ensure smooth rims.
  - Maintain floor and ceiling bounds.
  - Update `surface.version += 1` and append deformation summary (radius, depth, affected range) used by evidence hooks.
- `resolveProjectile` should return impact meta (exact x, affected indices, damage) and the crater summary, to include in the `ProjectileResolved` event payload.

## Simulation Flow Adjustments
- `createInitialState`: call `generateTerrain(seed)`, store returned `TerrainSurface`, and keep the RNG state for wind separate.
- `resolveProjectile`: after computing impact location and damage, call `applyCrater` to mutate terrain, update `MatchState.terrain`, and include deformation metadata in events.
- Ensure `publicState` exposes `terrain.version` and `heights` so clients can redraw efficiently.

## Client Rendering (`client/main.ts`)
- Derive pixel spacing from `surface.spacing` to render 512-sample terrain smoothly.
- Use `terrain.version` to gate re-render updates and optionally animate crater smoothing (e.g., highlight recent impact zone).

## Determinism & Replay
- All terrain generation/deformation functions must be pure and accept explicit seeds/parameters.
- Maintain simple `number[]` for heights to keep `stableStringify` effective (no typed arrays).
- Extend `tests/determinism.test.ts` to include crater mutations and assert identical hashes and `terrain.version` across runs.
- Update `packages/project-adapter-artillery/src/evidence.ts` to bake scenario-specific verifiers once the terrain metadata is exposed.

## Performance Guardrails
- Instrument `MatchStore.createMatch` to capture terrain generation latency and ensure it stays under the agreed budget (e.g., <5ms median in perf tests).
- Track `applyCommand` latency for `fire` commands separately, logging crater application cost (SCN-0304 evidence hook).
- Add `tests/performance-terrain.test.ts` using fake timers or benchmark harness to assert budgets in CI.

## Scenario Coverage Mapping
- **SCN-0301**: Variation metrics + spawn slot validation enforced in terrain generator; tests assert ridge/valley counts and spawn stability.
- **SCN-0302**: Determinism test and evidence harness hash the entire `TerrainSurface` after scripted command sequences.
- **SCN-0303**: Crater module unit tests validate smoothness and locality; simulation emits deformation metadata for replay.
- **SCN-0304**: Performance tests and ledger metrics ensure start/turn latencies remain within thresholds.

## Risks & Mitigations
- **Fairness regression**: enforce spawn stability validators and fail-fast if insufficient slots; add evidence snapshots to visual baselines.
- **Determinism drift**: avoid non-deterministic math (no Math.random, Date.now) in terrain flow; centralize RNG usage.
- **Performance degradation**: align algorithms to O(n) over sample count, reuse buffers if necessary, and profile in CI.
- **Network payload growth**: consider compressing terrain deltas (version + affected indices) if SSE payloads grow; initial implementation can send full array but measure size.
