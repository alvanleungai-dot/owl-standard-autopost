import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  companyStatePath,
  assertDurableStateRoot,
  DURABILITY_SENTINEL_CONTENT,
  REPO_ROOT,
  resetStateRootForTests,
  StateDirError,
} from "./paths.mjs";

const original = { CLOUD: process.env.CLOUD, RENDER: process.env.RENDER, STATE_DIR: process.env.STATE_DIR };
test.afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetStateRootForTests();
});

test("local default preserves the current in-repo layout", () => {
  delete process.env.CLOUD; delete process.env.RENDER; delete process.env.STATE_DIR;
  assert.equal(companyStatePath("tml", "weeks"), join(REPO_ROOT, "companies", "tml", "weeks"));
});

test("cloud mode without STATE_DIR fails closed and names STATE_DIR", () => {
  process.env.CLOUD = "1"; delete process.env.RENDER; delete process.env.STATE_DIR;
  assert.throws(() => companyStatePath("tml", "weeks"), (error) => {
    assert.equal(error instanceof StateDirError, true);
    assert.match(error.message, /STATE_DIR/);
    return true;
  });
});

test("an explicit STATE_DIR owns runtime paths", () => {
  const root = mkdtempSync(join(tmpdir(), "sce-state-"));
  try {
    process.env.STATE_DIR = root; delete process.env.CLOUD; delete process.env.RENDER;
    assert.equal(companyStatePath("sunmood", "weeks", "x.json"), join(root, "companies", "sunmood", "weeks", "x.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloud mode rejects a STATE_DIR that is not writable as a directory", () => {
  const root = mkdtempSync(join(tmpdir(), "sce-state-"));
  const file = join(root, "not-a-directory");
  try {
    writeFileSync(file, "x");
    process.env.CLOUD = "1"; process.env.STATE_DIR = file; delete process.env.RENDER;
    assert.throws(() => companyStatePath("tml", "weeks"), /STATE_DIR is not writable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime paths cannot escape STATE_DIR", () => {
  const root = mkdtempSync(join(tmpdir(), "sce-state-"));
  try {
    process.env.STATE_DIR = root; delete process.env.CLOUD; delete process.env.RENDER;
    assert.throws(() => companyStatePath("tml", "..", "..", "outside"), /escapes its root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloud durability rejects temp paths and a missing sentinel", () => {
  assert.throws(
    () => assertDurableStateRoot(join(tmpdir(), "sce-state"), { exists: () => true, read: () => DURABILITY_SENTINEL_CONTENT }),
    /ephemeral temp path/,
  );
  assert.throws(
    () => assertDurableStateRoot("C:\\durable\\sce", { exists: () => false }),
    /Durability sentinel is missing/,
  );
});

test("a valid sentinel accepts a non-temp non-checkout state root", () => {
  assert.equal(
    assertDurableStateRoot("C:\\durable\\sce", { exists: () => true, read: () => DURABILITY_SENTINEL_CONTENT }),
    "C:\\durable\\sce",
  );
});
