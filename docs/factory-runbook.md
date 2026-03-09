# Dark Factory Runbook

## Boundary Rules

- Factory plane uses only OpenAPI + CloudEvents contracts.
- No direct game-internal imports from factory packages.
- No factory-internal imports from game packages.
- OPA checks must pass before merge/deploy.

## Daily Operations

1. `npm run spec:lint`
2. `npm run contract:check`
3. `npm run policy:check`
4. Triage new requirements in GitHub Projects, then open a PR with exactly one changed `specs/SPEC-*.json`.
5. Review sticky `Spec Controller` comment and `reports/spec-controller/pr-<n>/manifest.json` artifact.
6. Maintainer decision via PR labels:
   - `factory/accept`
   - `factory/veto` (requires comment `/factory-reason SPEC-xxxx: ...`)
   - `factory/rollback` (requires comment `/factory-reason SPEC-xxxx: ...`)
7. Merge accepted spec PRs to `main`.
8. `spec-execution.yml` enqueues accepted `Approved` specs into the factory implementation queue.
9. The factory API worker builds project-scoped implementation context, invokes the Codex provider, and opens or updates draft PRs on `codex/implement-<spec-id>`.
10. The worker runs local checks plus adapter-backed evidence generation and only auto-merges when evidence, CI, policy, and branch protection gates pass.
11. Blocked or failed runs remain open as PRs with recorded task state; maintainers can retry or cancel through factory admin APIs.
12. `autonomous-deploy.yml` promotes verified specs through staging and production.

Centralized events:

- Set `FACTORY_API_BASE_URL` for staging/production runner jobs and project-control proxies.
- Use `FACTORY_EVENT_MODE=local` only for explicit local/test runs.

## Cloud Autonomous Flow

- Accepted specs merged to `main` trigger `spec-execution.yml`.
- Spec execution enqueues implementation tasks in factory storage and emits implementation telemetry.
- The Codex worker opens or reuses draft implementation PRs for pending code work.
- The worker writes evidence files, merges passing PRs, and then advances specs through `Implemented` and `Verified`.
- Push to `main` triggers staging deployment via reusable workflow.
- Canary gate must pass in staging before production promotion.
- Canary breach triggers `npm run factory:auto-rollback` before workflow exit.

## Emergency Rollback

1. `SPEC_ID=SPEC-xxxx REASON="incident summary" npm run factory:rollback`
2. Canary-driven batch rollback by deploy id:
   - `DEPLOY_ID=run-123-staging REASON="canary breach" npm run factory:auto-rollback`
3. Notify project plane:
   - `curl -X POST "$PROJECT_CONTROL_BASE_URL/v1/project/rollback" -H 'content-type: application/json' -d '{"specId":"SPEC-xxxx","reason":"incident summary"}'`
4. Regenerate reports:
   - `npm run reports:generate`
5. Optional NDJSON backfill into the centralized sink:
   - `FACTORY_API_BASE_URL=https://factory-api.example.com npm run factory:backfill-events -- /path/to/events.ndjson`

## Weekly Learning Loop

1. Generate health reports: `npm run reports:generate`
2. Generate feature proposals: `npm run feature:proposals`
3. Publish or sync proposals into the GitHub Project backlog for triage and deduplication.
4. Convert selected backlog items into new specs.
5. Process through the same spec->deploy pipeline.
