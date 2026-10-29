import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCHEDULED_JOBS } from "./worker-jobs.mjs";

const source = readFileSync(
  fileURLToPath(new URL("../preflight.mjs", import.meta.url)),
  "utf8",
);

test("daily non-publisher preflight reaps the publish ledger before provider probes", () => {
  const preflight = SCHEDULED_JOBS.find((job) => job.entry === "scripts/preflight.mjs");
  assert.ok(preflight);
  assert.equal(preflight.publisher, false);
  assert.equal(preflight.cron, "0 8 * * *");
  assert.match(source, /import\s+\{\s*reapPublishLedger\s*\}\s+from\s+["']\.\/lib\/publish-ledger-alert\.mjs["']/);
  const reapAt = source.indexOf("await reapPublishLedger()");
  const probesAt = source.indexOf("const results = await runAll()");
  assert.ok(reapAt >= 0 && reapAt < probesAt, "ledger reaper must run before external provider probes");
});
