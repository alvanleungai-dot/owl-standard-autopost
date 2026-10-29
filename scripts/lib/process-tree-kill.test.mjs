import test from "node:test";
import assert from "node:assert/strict";
import { killProcessTree } from "./process-tree-kill.mjs";

// DEFECT 1 (2026-07-31 adversarial review): a killed scheduled job can orphan a
// still-running, still-paying grandchild (Golf-Notion-Feedback -> execFileSync ->
// build-batch.mjs -> the gpt-image-2 request). These tests exercise the exact
// branch logic of killProcessTree entirely through injected fakes — never a real
// OS call against a made-up pid — so they stay hermetic and cannot collide with
// an unrelated real process on whatever machine runs them.

test("a child with no pid is left alone and reports false", () => {
  assert.equal(killProcessTree(null, "SIGTERM"), false);
  assert.equal(killProcessTree({}, "SIGTERM"), false);
  assert.equal(killProcessTree({ pid: "4242" }, "SIGTERM"), false); // string, not an integer
});

test("POSIX: signals the process GROUP (negative pid), not just the direct child", () => {
  const calls = [];
  const child = {
    pid: 4242,
    kill: () => { throw new Error("must not fall back to the direct child when the group signal succeeds"); },
  };
  const result = killProcessTree(child, "SIGTERM", {
    platform: "linux",
    killGroup: (pid, signal) => { calls.push({ pid, signal }); },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, [{ pid: 4242, signal: "SIGTERM" }]);
});

test("POSIX: falls back to the direct child if the process group is already gone", () => {
  const kills = [];
  const child = { pid: 4242, kill: (signal) => { kills.push(signal); return true; } };
  const result = killProcessTree(child, "SIGKILL", {
    platform: "linux",
    killGroup: () => { const e = new Error("ESRCH"); e.code = "ESRCH"; throw e; },
  });
  assert.equal(result, false);
  assert.deepEqual(kills, ["SIGKILL"]);
});

test("POSIX: a fallback kill on an already-dead direct child never throws", () => {
  const child = { pid: 4242, kill: () => { throw new Error("ESRCH"); } };
  assert.doesNotThrow(() => {
    const result = killProcessTree(child, "SIGTERM", {
      platform: "linux",
      killGroup: () => { throw new Error("ESRCH"); },
    });
    assert.equal(result, false);
  });
});

test("POSIX default killGroup signals the NEGATIVE pid — the whole process group, not the pid itself", () => {
  // The one behaviour that cannot be exercised via the injection seam (it IS the
  // default), so this test temporarily swaps the real process.kill instead of
  // ever sending a real signal, and always restores it.
  const original = process.kill;
  const calls = [];
  process.kill = (pid, signal) => { calls.push({ pid, signal }); return true; };
  try {
    const child = { pid: 424242, kill: () => { throw new Error("must not fall back"); } };
    const result = killProcessTree(child, "SIGTERM", { platform: "linux" });
    assert.equal(result, true);
    assert.deepEqual(calls, [{ pid: -424242, signal: "SIGTERM" }]);
  } finally {
    process.kill = original;
  }
});

test("Windows: uses taskkill /T /F to reach the whole tree, not a bare child.kill", () => {
  const calls = [];
  const child = {
    pid: 4242,
    kill: () => { throw new Error("must not fall back to the direct child when taskkill succeeds"); },
  };
  const result = killProcessTree(child, "SIGTERM", {
    platform: "win32",
    execFileSyncFn: (cmd, args, options) => { calls.push({ cmd, args, options }); return ""; },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, [{
    cmd: "taskkill",
    args: ["/pid", "4242", "/T", "/F"],
    options: { stdio: "ignore" },
  }]);
});

test("Windows: falls back to the direct child if taskkill itself fails", () => {
  const kills = [];
  const child = { pid: 4242, kill: (signal) => { kills.push(signal); return true; } };
  const result = killProcessTree(child, "SIGKILL", {
    platform: "win32",
    execFileSyncFn: () => { throw new Error("taskkill: process not found"); },
  });
  assert.equal(result, false);
  assert.deepEqual(kills, ["SIGKILL"]);
});

test("Windows: a fallback kill on an already-dead direct child never throws", () => {
  const child = { pid: 4242, kill: () => { throw new Error("already gone"); } };
  assert.doesNotThrow(() => {
    const result = killProcessTree(child, "SIGTERM", {
      platform: "win32",
      execFileSyncFn: () => { throw new Error("not found"); },
    });
    assert.equal(result, false);
  });
});
