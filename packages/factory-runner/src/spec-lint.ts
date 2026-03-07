import { createArtilleryAdapter } from "@darkfactory/project-adapter-artillery";
import { validateSpec } from "@darkfactory/core";

const adapter = createArtilleryAdapter();
const specs = await adapter.listSpecs();
let failed = false;

for (const spec of specs) {
  const issues = validateSpec(spec.data);
  if (issues.length > 0) {
    failed = true;
    console.error(`[spec-lint] ${spec.path}`);
    for (const issue of issues) {
      console.error(`  - ${issue}`);
    }
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`[spec-lint] ${specs.length} specs valid`);
}
