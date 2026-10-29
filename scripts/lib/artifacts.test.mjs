import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertArtifactsWritable, ArtifactExistsError, parseWrote, wroteLine } from "./artifacts.mjs";
import { IDEMPOTENT_NOOP_EXIT_CODE } from "./process-outcome.mjs";

test("an existing dated artifact is a no-op failure unless forced", () => {
  const root = mkdtempSync(join(tmpdir(), "sce-artifact-"));
  const path = join(root, "2026-08-03.json");
  try {
    writeFileSync(path, "original");
    assert.throws(() => assertArtifactsWritable([path]), ArtifactExistsError);
    assert.equal(readFileSync(path, "utf8"), "original");
    assert.deepEqual(assertArtifactsWritable([path], { force: true }), [resolve(path)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WROTE handoff is absolute and exactly one line", () => {
  const path = resolve("some-week.json");
  assert.equal(parseWrote(`noise\n${wroteLine(path)}\nmore`, "test"), path);
  assert.throws(() => parseWrote("noise only", "test"), /exactly one/);
  assert.throws(() => parseWrote(`${wroteLine(path)}\n${wroteLine(path)}`, "test"), /exactly one/);
});

test("every uncaught artifact guard reports the dedicated idempotent no-op process outcome", () => {
  const root = mkdtempSync(join(tmpdir(), "sce-artifact-boundary-"));
  const path = join(root, "already-done.json");
  try {
    writeFileSync(path, "approved content");
    const source =
      `import { assertArtifactsWritable } from ${JSON.stringify(new URL("./artifacts.mjs", import.meta.url).href)};` +
      `assertArtifactsWritable([${JSON.stringify(path)}]);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
    });
    assert.equal(result.status, IDEMPOTENT_NOOP_EXIT_CODE);
    assert.match(result.stderr, /^IDEMPOTENT_NOOP reason=artifact_exists/m);
    assert.equal(readFileSync(path, "utf8"), "approved content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
