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
4. `npm run factory:critic`
5. `npm run factory:evaluate`
6. Review `reports/evaluations/*.json`
7. Maintainer decision:
   - `SPEC_ID=SPEC-xxxx npm run factory:accept`
   - `SPEC_ID=SPEC-xxxx REASON="..." npm run factory:veto`
8. Continue flow:
   - `npm run factory:implement`
   - `npm run factory:verify`
   - `npm run canary`
   - `npm run factory:deploy`

## Cloud Autonomous Flow

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

## Weekly Learning Loop

1. Generate health reports: `npm run reports:generate`
2. Generate feature proposals: `npm run feature:proposals`
3. Convert accepted proposals into new specs.
4. Process through the same spec->deploy pipeline.
