import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../gatekeeper.mjs", import.meta.url)),
  "utf8",
);

test("cloud gatekeeper has no generation-log signal that can report a false green", () => {
  assert.doesNotMatch(source, /gatherGenerationScan/);
  assert.doesNotMatch(source, /runtimePath\(["']logs["']\)/);
  assert.doesNotMatch(source, /triageGeneration\(/);
});

test("every Gatekeeper auto-fix execution consumes the explicit authorization capability", () => {
  assert.match(
    source,
    /const AUTOFIX_AUTHORIZATION = gatekeeperAutofixAuthorization\(\)/,
  );
  assert.match(
    source,
    /assertGatekeeperAutofixAuthorized\(authorization\)/,
  );
  assert.match(
    source,
    /executeAutoSafe\(f\.plan,\s*AUTOFIX_AUTHORIZATION\)/,
  );
});
