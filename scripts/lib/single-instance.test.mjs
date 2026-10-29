import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSingleInstance,
  INSTANCE_LEASE_NAME,
  releaseSingleInstance,
  SiblingInstanceError,
} from "./single-instance.mjs";

test("a fresh sibling lease makes startup fail", () => {
  const root = mkdtempSync(join(tmpdir(), "sce-instance-"));
  try {
    writeFileSync(join(root, INSTANCE_LEASE_NAME), JSON.stringify({
      instance_id: "instance-a",
      seen_at: "2026-07-29T12:00:00.000Z",
    }));
    assert.throws(
      () => assertSingleInstance({
        root,
        env: { SCE_INSTANCE_ID: "instance-b" },
        nowMs: Date.parse("2026-07-29T12:01:00.000Z"),
      }),
      SiblingInstanceError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hard kill still recovers by replacing a stale sibling lease", () => {
  const root = mkdtempSync(join(tmpdir(), "sce-instance-"));
  try {
    assert.equal(assertSingleInstance({ root, env: { SCE_INSTANCE_ID: "same" }, nowMs: 1000 }).instance_id, "same");
    assert.equal(assertSingleInstance({ root, env: { SCE_INSTANCE_ID: "same" }, nowMs: 2000 }).instance_id, "same");
    assert.equal(
      assertSingleInstance({ root, env: { SCE_INSTANCE_ID: "new" }, nowMs: 10 * 60 * 1000 }).instance_id,
      "new",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean shutdown releases only the lease owned by this process", () => {
  const root = mkdtempSync(join(tmpdir(), "sce-instance-"));
  const path = join(root, INSTANCE_LEASE_NAME);
  try {
    const lease = assertSingleInstance({ root, env: { SCE_INSTANCE_ID: "owned" }, nowMs: 1000 });
    assert.equal(releaseSingleInstance({ root, lease }), true);
    assert.equal(existsSync(path), false);

    const nextLease = assertSingleInstance({ root, env: { SCE_INSTANCE_ID: "next" }, nowMs: 2000 });
    assert.equal(releaseSingleInstance({ root, lease }), false);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).instance_id, "next");
    assert.equal(releaseSingleInstance({ root, lease: nextLease }), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
