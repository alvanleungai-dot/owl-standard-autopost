import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.SCE_IMPORT_ONLY = "1";
const { runTopup } = await import("../fb-topup.mjs");
delete process.env.SCE_IMPORT_ONLY;

test("top-up attempts every brand, alarms, and returns non-zero when children fail", async () => {
  const schedulers = ["better-life", "sunmood", "tml", "bright-day"];
  const attempted = [];
  const alerts = [];
  const result = await runTopup({
    schedulers,
    runScheduler: (scheduler) => {
      attempted.push(scheduler);
      if (scheduler === "better-life") {
        throw Object.assign(new Error("failed"), { status: 7 });
      }
      if (scheduler === "tml") throw new Error("spawn failed");
    },
    alert: async (issue) => { alerts.push(issue); return true; },
    resolveAlert: () => assert.fail("a failed run must not clear its alarm"),
    log: () => {},
  });

  assert.deepEqual(attempted, schedulers);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.failures, [
    { scheduler: "better-life", code: 7 },
    { scheduler: "tml", code: null },
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "job-failed:SCE-FB-Topup");
  assert.match(alerts[0].text, /better-life \(exit 7\)/);
  assert.match(alerts[0].text, /tml \(exit unknown\)/);
});

test("top-up success raises no alarm and clears the prior failure key", async () => {
  const alerts = [];
  const resolved = [];
  const result = await runTopup({
    schedulers: ["one", "two", "three", "four"],
    runScheduler: () => {},
    alert: async (issue) => { alerts.push(issue); return true; },
    resolveAlert: (source, kind) => resolved.push({ source, kind }),
    log: () => {},
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(alerts, []);
  assert.deepEqual(resolved, [{
    source: "render-worker",
    kind: "job-failed:SCE-FB-Topup",
  }]);
});

test("top-up entry point propagates aggregate failure to process.exitCode", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../fb-topup.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(source, /if\s*\(!result\.ok\)\s*process\.exitCode\s*=\s*result\.exitCode/);
});
