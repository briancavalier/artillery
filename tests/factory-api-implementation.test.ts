import { test } from "node:test";
import assert from "node:assert/strict";
import { implementationInternals } from "../apps/factory-api/src/implementation.js";

test("buildPortableNodeCommand uses bash-compatible fnm/nvm bootstrapping", () => {
  const command = implementationInternals.buildPortableNodeCommand("npm test");
  assert.match(command, /fnm env --shell bash/);
  assert.match(command, new RegExp("if command -v nvm >/dev/null 2>&1; then nvm use >/dev/null; fi"));
  assert.match(command, /npm test$/);
  assert.doesNotMatch(command, /\/bin\/zsh/);
});
