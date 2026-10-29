import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { publisherGateFailures } from "./publisher-gate.mjs";

// Every live publisher (scripts/**/api-*.mjs) must carry the freeze check, the approval check and the
// ledger boundary. This used to be asserted only by scripts/task-health.mjs, a WINDOWS Task Scheduler
// monitor (archived 2026-09-18); as a test it now runs on every change, on any machine.
const scriptsDir = fileURLToPath(new URL("../", import.meta.url));
const publishers = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? publishers(join(dir, entry.name))
    : /^api-.*\.mjs$/.test(entry.name) && !entry.name.endsWith(".test.mjs") ? [join(dir, entry.name)] : []);

test("every scripts/**/api-*.mjs publisher passes the publisher gate", () => {
  const files = publishers(scriptsDir);
  assert.ok(files.length >= 2, "expected at least the Facebook and Instagram publishers");
  for (const file of files) {
    const relativePath = relative(scriptsDir, file).replace(/\\/g, "/");
    assert.deepEqual(publisherGateFailures({ source: readFileSync(file, "utf8"), relativePath }), [], relativePath);
  }
});

test("publisher gate rejects a live writer missing every shared guard", () => {
  const failures = publisherGateFailures({
    relativePath: "lib/unsafe.mjs",
    source: `async function publish() { await fetch("/photos", { method: "POST" }); }`,
  });
  assert.deepEqual(failures, [
    "no assertNotFrozen() call",
    "no approval call",
    "no publishClaimed() boundary",
  ]);
});

test("publisher gate rejects repo-relative mutable state reads", () => {
  const failures = publisherGateFailures({
    relativePath: "unsafe.mjs",
    source: `
      assertNotFrozen();
      isApproved(post);
      publishClaimed({});
      const weeks = new URL("../companies/tml/weeks", import.meta.url);
    `,
  });
  assert.deepEqual(failures, ["repo-relative mutable state path"]);
});
