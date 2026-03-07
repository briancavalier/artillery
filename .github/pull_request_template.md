## Feature Spec Submission

Use this template for both human and agent proposed features.

- [ ] Added or updated `specs/SPEC-xxxx.json`
- [ ] Included all required fields (`SpecID`, intent, scenarios, verification, risk notes)
- [ ] Set `source` to `human` or `agent`
- [ ] Added/updated scenario evidence plan under `evidence/<SpecID>/`
- [ ] Ran `npm run spec:lint`
- [ ] Ran `npm run contract:check`
- [ ] Ran `npm run policy:check`

### Spec Summary

- `SpecID`:
- `Title`:
- `Source (human|agent)`:
- `Owner`:

### Intent

Describe user value and constraints.

### Scenarios

List key `ScenarioID`s and behavior.

### Verification Map

Map each required scenario to checks.

### Risk Notes

Describe concrete risks and mitigations.

### Maintainer Decision

- [ ] Accept
- [ ] Veto
- [ ] Request refinement

If vetoing or requesting refinement, include rationale.
