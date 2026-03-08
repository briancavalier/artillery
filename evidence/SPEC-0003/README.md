# SPEC-0003 Evidence Plan

## Scenario Coverage

- `SCN-0301`:
  - Match generation snapshot set shows varied silhouettes and valid spawn placement.
  - Artifact: `evidence/SPEC-0003/SCN-0301.json`
- `SCN-0302`:
  - Replay verification run confirms byte-equivalent terrain and deformation states for fixed seed + commands.
  - Artifact: `evidence/SPEC-0003/SCN-0302.json`
- `SCN-0303`:
  - Impact regression suite confirms crater smoothness and local deformation boundaries.
  - Artifact: `evidence/SPEC-0003/SCN-0303.json`
- `SCN-0304`:
  - Performance run confirms match start and turn-loop latency remain within target budget.
  - Artifact: `evidence/SPEC-0003/SCN-0304.json`

## Evidence Record Format

Each scenario evidence JSON should include:

- `scenarioId`
- `passed` (`true`/`false`)
- `at` (ISO timestamp)
- `artifact` (optional path or report id)
