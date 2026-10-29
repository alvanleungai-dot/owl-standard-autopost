import { test } from "node:test";
import assert from "node:assert/strict";
import { unhealthyTasks, toHex, BENIGN_RESULTS } from "./task-health-core.mjs";

test("toHex formats as unsigned hex", () => {
  assert.equal(toHex(0), "0x0");
  assert.equal(toHex(1), "0x1");
  assert.equal(toHex(2), "0x2");
  assert.equal(toHex(-2), "0xFFFFFFFE"); // negative ints wrap to unsigned (Task Scheduler reports uint32)
});

test("benign set covers success / running / never-run only", () => {
  assert.ok(BENIGN_RESULTS.has(0x0));
  assert.ok(BENIGN_RESULTS.has(0x41301));
  assert.ok(BENIGN_RESULTS.has(0x41303));
  assert.ok(!BENIGN_RESULTS.has(0x1)); // 0x1 (script exit 1) is a real failure
});

test("unhealthyTasks flags only watched, enabled, non-benign tasks", () => {
  const rows = [
    { name: "TML-AutoSchedule", state: "Ready", lastResult: 1 },           // 0x1 fail → flag
    { name: "BetterLife-AutoSchedule", state: "Ready", lastResult: 0 },    // success → ok
    { name: "SCE-Catchup", state: "Running", lastResult: 267009 },         // running → ok
    { name: "SCE-Preflight", state: "Ready", lastResult: 267011 },         // never run → ok
    { name: "BetterLife-GenerateWeek", state: "Disabled", lastResult: 1 }, // disabled → ignore
    { name: "SomeOtherApp", state: "Ready", lastResult: 1 },               // not watched → ignore
  ];
  const bad = unhealthyTasks(rows, ["TML", "BetterLife", "SCE", "Sunmood"]);
  assert.deepEqual(bad.map((b) => b.name), ["TML-AutoSchedule"]);
  assert.equal(bad[0].hex, "0x1");
});

test("unhealthyTasks tolerates empty / unwatched inputs", () => {
  assert.deepEqual(unhealthyTasks(null, ["X"]), []);
  assert.deepEqual(unhealthyTasks([{ name: "X-Task", state: "Ready", lastResult: 2 }], []), []);
});

test("BrightDay tasks are watched (regression: WATCH + the scheduler query both derive from one brand list)", () => {
  const watch = ["BetterLife", "TML", "Sunmood", "SCE", "BrightDay"];
  const bad = unhealthyTasks([{ name: "BrightDay-GenerateWeek", state: "Ready", lastResult: 1 }], watch);
  assert.deepEqual(bad.map((b) => b.name), ["BrightDay-GenerateWeek"]); // 0x1 failure on a BrightDay task is caught
});

test("exit 2 is benign for MONITOR tasks (by-design 'found+escalated'), not for others", () => {
  const rows = [
    { name: "SCE-Gatekeeper", state: "Ready", lastResult: 2 },            // monitor exit 2 → benign
    { name: "SCE-TaskHealth", state: "Ready", lastResult: 2 },            // monitor exit 2 → benign
    { name: "SCE-Watchdog", state: "Ready", lastResult: 2 },              // monitor exit 2 → benign
    { name: "SCE-Preflight", state: "Ready", lastResult: 2 },             // monitor exit 2 → benign
    { name: "BetterLife-WeeklyAutopilot", state: "Ready", lastResult: 2 },// generation FAILURE (gen-week exits 2) → FLAG
    { name: "SCE-Gatekeeper", state: "Ready", lastResult: 1 },            // monitor real CRASH (0x1) → FLAG
  ];
  const bad = unhealthyTasks(rows, ["SCE", "BetterLife", "TML", "Sunmood"]);
  assert.deepEqual(
    bad.map((b) => `${b.name} ${b.hex}`),
    ["BetterLife-WeeklyAutopilot 0x2", "SCE-Gatekeeper 0x1"],
  );
});
