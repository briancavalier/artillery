# Plane Boundary Contract

## Allowed Integration Surface

Factory plane -> Game plane:

- `GET /v1/project/health`
- `POST /v1/project/canary`
- `POST /v1/project/scenarios/{scenarioId}/verify`
- `POST /v1/project/rollback`

Game plane -> Factory plane:

- `POST /v1/events` (CloudEvents only)

## Forbidden Coupling

- Factory packages importing `apps/artillery-game/**`
- Game package importing `packages/factory-core/**`, `packages/factory-runner/**`, or project adapters
- Direct database access across plane boundaries

## Event Contract

Event payloads MUST include:

- `specId`
- `scenarioId`
- `deployId`
- `matchId`
- `action`
- `actor`

Schema source of truth: `packages/factory-contracts/cloudevents/*.v1.schema.json`

## Enforcement

- Static policy checks: `npm run policy:check`
- OPA policy tests: `opa test policy/opa -v`
- OPA deny evaluation: `opa eval --fail-defined -d policy/opa -i policy-input.json 'data.darkfactory.deny[_]'`
