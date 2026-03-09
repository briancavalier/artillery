# Artillery + Reusable Dark Factory Monorepo

Cloud-first multiplayer artillery game with a reusable, boundary-enforced autonomous factory.

## Planes and Boundaries

This repo is split into two independent planes:

- **Game Plane**: `apps/artillery-game`
- **Factory Plane**: `apps/factory-api` + `packages/factory-*`

Hard boundary contract:

- Factory interacts with game only through `project-control.v1` HTTP endpoints.
- Game never imports factory internals.
- Factory never imports game internals.
- Telemetry exchange uses CloudEvents v1 schemas.
- OPA policies enforce boundaries in CI and deploy workflows.

## Monorepo Topology

- `apps/artillery-game`: multiplayer runtime and project-control endpoints
- `apps/factory-api`: factory admin/event ingestion API
- `packages/factory-contracts`: OpenAPI + CloudEvents + shared types
- `packages/factory-core`: generic spec pipeline engine
- `packages/factory-runner`: reusable runner CLI and workflow-compatible commands
- `packages/project-adapter-artillery`: artillery-specific adapter for factory-core

## Contracts

OpenAPI:

- `packages/factory-contracts/openapi/project-control.v1.json`
- `packages/factory-contracts/openapi/factory-admin.v1.json`

CloudEvents schemas:

- `packages/factory-contracts/cloudevents/*.v1.schema.json`

Each event schema requires correlation ids:

- `specId`
- `scenarioId`
- `deployId`
- `matchId`

## Local Development

```bash
nvm use
npm install
npm run build
npm start
```

Game URL: `http://127.0.0.1:4173`

Factory API URL:

```bash
npm run start:factory-api
```

Factory API default URL: `http://127.0.0.1:4174`
Factory dashboard URL: `http://127.0.0.1:4174/dashboard`

## Factory Commands

All commands run through `@darkfactory/runner`:

```bash
npm run spec:lint
npm run factory:critic
npm run factory:evaluate
npm run factory:refine
npm run factory:accept -- SPEC-0001
npm run factory:veto -- SPEC-0001 "reason"
npm run factory:architect -- SPEC-0001
npm run factory:implement
npm run factory:verify
npm run factory:deploy
npm run factory:rollback -- SPEC-0001 "reason"
npm run factory:auto-rollback
npm run factory:spec-controller -- analyze
npm run factory:spec-architecture
npm run factory:spec-execution -- act
npm run canary
npm run reports:generate
npm run feature:proposals
```

## Policy and Contract Enforcement

```bash
npm run contract:check
npm run policy:check
```

CI runs:

- Build and tests
- Spec lint
- OpenAPI/CloudEvents contract checks
- OPA policy tests and policy evaluation

## Cloud Automation

Workflows:

- `.github/workflows/ci.yml`: PR + push quality gates
- `.github/workflows/factory-runner-reusable.yml`: reusable `workflow_call` runner
- `.github/workflows/autonomous-deploy.yml`: staging then production autonomous deployment
- `.github/workflows/weekly-learning.yml`: scheduled learning/proposals run
- `.github/workflows/spec-controller.yml`: PR spec analysis + label-driven governance
- `.github/workflows/spec-architecture.yml`: `main` branch architecture queue + artifact PR auto-merge
- `.github/workflows/spec-execution.yml`: `main` branch implementation queue + evidence-driven advancement

Render blueprint:

- `render.yaml` defines staging + production for both planes
- Separate Postgres databases for game and factory in each environment

## Environment Variables

Common:

- `SPEC_DIR`, `EVIDENCE_DIR`, `CANARY_PATH`
- `SPEC_ID`, `REASON`, `DRY_RUN`, `DEPLOY_ID`
- `CANARY_MIN_MATCHES` (default `5`; minimum match sample before reject-rate gate is enforced)
- `FACTORY_EVENT_MODE=local` for explicit local/test event storage

Deploy:

- `RENDER_STAGING_DEPLOY_HOOK`
- `RENDER_PROD_DEPLOY_HOOK`
- `FACTORY_COMMIT_SHA` (optional override; defaults to `GITHUB_SHA` in workflows)
- `PROJECT_CONTROL_BASE_URL`

Factory API:

- `FACTORY_DATABASE_URL` (Postgres)
- `FACTORY_API_BASE_URL` (required for centralized event readers/writers outside local mode)
- `FACTORY_STATE_PATH` (local-mode file fallback only)
- `OPENAI_API_KEY` (required for the Codex implementation provider in cloud execution)
- `OPENAI_MODEL` (optional; defaults to `gpt-5-codex`)
- `OPENAI_PROJECT` (optional project scoping for provider usage)

## Human + Agent Spec Intake

Specs are source artifacts in `specs/SPEC-xxxx.json` for both humans and agents.
Use `.github/pull_request_template.md` for submission.

GitHub Projects is a good fit for backlog intake and triage ahead of spec creation:

- human requests and agent proposals can share one requirement queue
- accepted backlog items should graduate into a single-spec PR
- once a spec PR exists, `specs/SPEC-xxxx.json` remains the source of truth

See [docs/github-projects-requirements.md](/Users/brian/dev/@briancavalier/artillery/docs/github-projects-requirements.md) for the recommended operating model.

## Spec Controller (PR Automation)

`spec-controller.yml` runs in pull request context and automatically evaluates changed `specs/SPEC-*.json`.

- Auto analysis: `critic -> evaluate -> refine` semantics with sticky PR summary.
- Same-repo PRs: controller bot commits status updates back to PR branch.
- Fork PRs: read-only analysis (no branch mutations).

Maintainer decision labels:

- `factory/accept`
- `factory/veto`
- `factory/rollback`

Rationale directive required for `veto` and `rollback`:

`/factory-reason SPEC-xxxx: <reason text>`

## Spec Architecture (Post-Merge Automation)

`spec-architecture.yml` runs on trusted `main` pushes after an accepted spec lands on `main`.

- Enqueues accepted `Approved` specs into the factory architecture queue.
- Builds a project-scoped architecture context and repo-wide discovery seed set from the artillery adapter.
- Invokes the Codex architect provider on `codex/architect-<spec-id>`.
- Publishes repo-tracked artifacts under `architecture/<SpecID>/`.
- Auto-marks PRs ready and auto-merges only when the PR touches architecture artifact paths only and CI/policy checks pass.
- Advances accepted specs through `Approved -> Architected`.

Architecture artifacts:

- `architecture/<SpecID>/README.md`
- `architecture/<SpecID>/integration-points.json`
- `architecture/<SpecID>/invariants.json`
- `architecture/<SpecID>/scenario-trace.json`

## Spec Execution (Post-Merge Automation)

`spec-execution.yml` runs on trusted `main` pushes after a spec is `Architected`.

- Enqueues accepted `Architected` specs into the factory implementation queue.
- Builds a project-scoped implementation context from the artillery adapter plus architecture artifacts.
- Invokes the pluggable Codex implementation provider on `codex/implement-<spec-id>`.
- Uses repo-wide read discovery with narrow write allowlists. Architecture-selected integration points are mandatory context; supplemental discovery is capped.
- Runs local build/test/policy checks plus adapter-backed scenario evidence generation.
- Auto-marks PRs ready and auto-merges only after evidence, CI, policy, and branch protection gates pass.
- Leaves the PR open and the task `blocked` or `failed` when:
  - evidence is incomplete
  - CI/policy checks fail
  - artifact paths violate the implementation scope
  - the spec is vetoed or rolled back during execution
- Auto-advances accepted specs through `Implemented -> Verified` when the project adapter can generate required scenario evidence.
- Leaves unsupported scenarios in place with explicit failed evidence files instead of promoting them.

For artillery today, adapter-managed evidence generation is implemented for:

- `SCN-0001`
- `SCN-0002`
- `SCN-0003`
