import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createScheduledJobSupervisor } from "./scheduled-job-runtime.mjs";
import { IDEMPOTENT_NOOP_EXIT_CODE } from "./process-outcome.mjs";

// Every test below injects a killTree stub rather than relying on the real
// scripts/lib/process-tree-kill.mjs default. That default shells out to a real OS
// primitive (process.kill(-pid) on POSIX, `taskkill /T` on Windows) — exercising
// it against these tests' made-up pids would mean either doing real, slow
// subprocess/syscall work in a unit test, or (worse) risking a collision with an
// unrelated real process at a small pid on a shared machine. The real mechanism
// has its own dedicated, fully-hermetic coverage in process-tree-kill.test.mjs.
function killTreeStub() {
  const calls = [];
  return {
    calls,
    fn: (child, signal) => {
      calls.push({ pid: child.pid, signal });
      return child.kill(signal);
    },
  };
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(fn, ms) {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.cleared = true;
    },
  };
}

test("a hung scheduled child is terminated, force-killed, and alarmed by name", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    kills: [],
    kill(signal) { this.kills.push(signal); return true; },
  });
  const clock = fakeTimers();
  const alerts = [];
  const errors = [];
  const killTree = killTreeStub();
  const supervisor = createScheduledJobSupervisor({
    spawnChild: () => child,
    alert: async (issue) => { alerts.push(issue); return true; },
    log: () => {},
    logError: (line) => errors.push(line),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    killGraceMs: 10,
    killTree: killTree.fn,
  });

  supervisor.start({ name: "SCE-Test-Hang", maxRuntimeMs: 50 });
  assert.equal(supervisor.has("SCE-Test-Hang"), true);
  assert.equal(clock.timers[0].ms, 50);
  clock.timers[0].fn();
  await Promise.resolve();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  // The supervisor must go through killTree (the whole-process-tree mechanism),
  // never call child.kill() directly — that is exactly what let a killed job's own
  // grandchild (build-batch.mjs) outlive it before this fix.
  assert.deepEqual(killTree.calls, [{ pid: 4242, signal: "SIGTERM" }]);
  assert.equal(alerts[0].kind, "job-max-runtime:SCE-Test-Hang");
  assert.ok(errors.some((line) => line.includes("JOB_MAX_RUNTIME_EXCEEDED job=SCE-Test-Hang")));

  clock.timers[1].fn();
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(killTree.calls, [
    { pid: 4242, signal: "SIGTERM" },
    { pid: 4242, signal: "SIGKILL" },
  ]);
  assert.ok(errors.some((line) => line.includes("JOB_FORCE_KILL job=SCE-Test-Hang")));

  child.emit("exit", 1, "SIGKILL");
  assert.equal(supervisor.has("SCE-Test-Hang"), false);
  await Promise.resolve();
  assert.equal(alerts.length, 1, "the non-zero timeout exit must not raise a second alarm");
});

test("failed overrun alarm is itself a distinct loud worker failure", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 7,
    kill() { return true; },
  });
  const clock = fakeTimers();
  const errors = [];
  const supervisor = createScheduledJobSupervisor({
    spawnChild: () => child,
    alert: async () => false,
    log: () => {},
    logError: (line) => errors.push(line),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    killTree: killTreeStub().fn,
  });
  supervisor.start({ name: "SCE-No-Alert", maxRuntimeMs: 1 });
  clock.timers[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(errors.some((line) =>
    line === "worker: ALERT_DELIVERY_FAILED job=SCE-No-Alert event=JOB_MAX_RUNTIME_EXCEEDED"));
});

test("a normal exit clears its deadline, frees the job slot, and raises no alarm", () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 9,
    kill() { throw new Error("normal exit must not be killed"); },
  });
  const clock = fakeTimers();
  const alerts = [];
  const resolved = [];
  const supervisor = createScheduledJobSupervisor({
    spawnChild: () => child,
    alert: async (issue) => { alerts.push(issue); return true; },
    resolveAlert: (source, kind) => resolved.push({ source, kind }),
    log: () => {},
    logError: () => {},
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  supervisor.start({ name: "SCE-Normal", maxRuntimeMs: 100 });
  child.emit("exit", 0, null);
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(supervisor.has("SCE-Normal"), false);
  assert.deepEqual(alerts, []);
  assert.deepEqual(resolved, [{
    source: "render-worker",
    kind: "job-failed:SCE-Normal",
  }]);
});

test("a non-zero scheduled child exit raises an alarm with job name and exit code", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 10,
    kill() { return true; },
  });
  const clock = fakeTimers();
  const alerts = [];
  const supervisor = createScheduledJobSupervisor({
    spawnChild: () => child,
    alert: async (issue) => { alerts.push(issue); return true; },
    log: () => {},
    logError: () => {},
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  supervisor.start({ name: "WeeklyAutopilot", maxRuntimeMs: 100 });
  child.emit("exit", 7, null);
  await Promise.resolve();

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "job-failed:WeeklyAutopilot");
  assert.match(alerts[0].text, /WeeklyAutopilot/);
  assert.match(alerts[0].text, /code 7/);
});

test("exit code 2 (the job already escalated its own findings) raises no second generic alarm", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 13,
    kill() { return true; },
  });
  const alerts = [];
  const logs = [];
  const supervisor = createScheduledJobSupervisor({
    spawnChild: () => child,
    alert: async (issue) => { alerts.push(issue); return true; },
    log: (line) => logs.push(line),
    logError: () => {},
  });
  supervisor.start({ name: "SCE-Preflight", maxRuntimeMs: 100 });
  child.emit("exit", 2, null);
  await Promise.resolve();
  assert.deepEqual(alerts, []);
  assert.match(logs.join("\n"), /SCE-Preflight reported issues \(exit 2\)/);
});

test("the dedicated idempotent no-op exit is resolved and never alarmed", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 12,
    kill() { return true; },
  });
  const alerts = [];
  const resolved = [];
  const observed = [];
  const logs = [];
  const supervisor = createScheduledJobSupervisor({
    spawnChild: () => child,
    alert: async (issue) => { alerts.push(issue); return true; },
    resolveAlert: (source, kind) => resolved.push({ source, kind }),
    log: (line) => logs.push(line),
    logError: () => {},
  });

  supervisor.start(
    { name: "WeeklyAutopilot", maxRuntimeMs: 100 },
    { onExit: (outcome) => observed.push(outcome) },
  );
  child.emit("exit", IDEMPOTENT_NOOP_EXIT_CODE, null);
  await Promise.resolve();

  assert.deepEqual(alerts, []);
  assert.deepEqual(resolved, [{
    source: "render-worker",
    kind: "job-failed:WeeklyAutopilot",
  }]);
  assert.equal(observed[0].idempotentNoop, true);
  assert.match(logs.join("\n"), /completed as idempotent no-op/);
});

test("shutdown exits do not raise scheduled-job failure alarms", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 11,
    kill() { this.emit("exit", 1, "SIGTERM"); return true; },
  });
  const alerts = [];
  const killTree = killTreeStub();
  const supervisor = createScheduledJobSupervisor({
    spawnChild: () => child,
    alert: async (issue) => { alerts.push(issue); return true; },
    log: () => {},
    logError: () => {},
    killTree: killTree.fn,
  });

  supervisor.start({ name: "SCE-Shutdown", maxRuntimeMs: 100 });
  supervisor.stopAll();
  await Promise.resolve();
  assert.deepEqual(alerts, []);
  // stopAll must ALSO reach the whole process tree, not just the direct child —
  // a redeploy/shutdown that only killed the direct child would leave the same
  // orphaned-grandchild risk this fix closes for the maxRuntimeMs timeout path.
  assert.deepEqual(killTree.calls, [{ pid: 11, signal: "SIGTERM" }]);
});
