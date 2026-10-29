// Adapter for Node/Windows, where `node --test scripts/lib/` resolves the
// directory as a module instead of discovering its *.test.mjs children.
// Run each test file as its own Node process so Node preserves per-file process
// isolation (several path tests intentionally mutate process.env).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("scripts/lib test suite", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => join(dir, name));
  for (const file of files) {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [file], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnv,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(result.status, 0, `${file} exited ${result.status}`);
  }
});
