import { readAllSpecs, validateSpec } from "./lib/spec-store.mjs";

const specs = await readAllSpecs();
let failed = false;

for (const { path, data } of specs) {
  const issues = validateSpec(data);
  if (issues.length > 0) {
    failed = true;
    console.error(`[spec-lint] ${path}`);
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
