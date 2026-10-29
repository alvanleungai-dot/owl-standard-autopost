import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createLongLivedSupervisor,
  LONG_LIVED_MAX_CONSECUTIVE_RESTARTS,
} from "./long-lived-supervisor.mjs";

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killedWith = null;
  }

  kill(signal) {
    this.killedWith = signal;
  }
}

test("an exited long-lived child is restarted with backoff and the restart is logged", () => {
  const children = [];
  const scheduled = [];
  const logs = [];
  const supervisor = createLongLivedSupervisor({
    spawnChild: () => {
      const child = new FakeChild(100 + children.length);
      children.push(child);
      return child;
    },
    enabled: () => true,
    isStopping: () => false,
    log: (line) => logs.push(line),
    schedule: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
  });
  const item = { name: "TML review bot", env: "JOB_TML_REVIEW_BOT_ENABLED" };

  supervisor.start(item);
  children[0].emit("exit", 1, null);
  assert.equal(scheduled[0].delay, 5_000);
  assert.ok(logs.includes("worker: restart scheduled TML review bot delay=5000ms attempt=1/5"));
  scheduled[0].callback();
  assert.equal(children.length, 2);
  assert.ok(logs.includes("worker: started TML review bot pid=101"));
});

test("a crash loop stops at the restart cap and escalates through the alert path", async () => {
  const children = [];
  const scheduled = [];
  const errors = [];
  const alerts = [];
  const supervisor = createLongLivedSupervisor({
    spawnChild: () => {
      const child = new FakeChild(200 + children.length);
      children.push(child);
      return child;
    },
    enabled: () => true,
    isStopping: () => false,
    log: () => {},
    logError: (line) => errors.push(line),
    alert: async (payload) => { alerts.push(payload); return true; },
    schedule: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
  });
  const item = { name: "Sunmood review bot", env: "JOB_SUNMOOD_REVIEW_BOT_ENABLED" };

  supervisor.start(item);
  for (let attempt = 0; attempt < LONG_LIVED_MAX_CONSECUTIVE_RESTARTS; attempt += 1) {
    children.at(-1).emit("exit", 1, null);
    scheduled.at(-1).callback();
  }
  children.at(-1).emit("exit", 1, null);
  await Promise.resolve();

  assert.equal(children.length, LONG_LIVED_MAX_CONSECUTIVE_RESTARTS + 1);
  assert.deepEqual(scheduled.map((timer) => timer.delay), [5_000, 15_000, 60_000, 60_000, 60_000]);
  assert.equal(alerts.length, 1);
  assert.match(errors.at(-1), /FATAL restart cap hit/);
  assert.equal(alerts[0].source, "render-worker");
});

test("a failed crash-loop delivery is a named loud worker failure", async () => {
  const children = [];
  const scheduled = [];
  const errors = [];
  const supervisor = createLongLivedSupervisor({
    spawnChild: () => {
      const child = new FakeChild(300 + children.length);
      children.push(child);
      return child;
    },
    enabled: () => true,
    isStopping: () => false,
    log: () => {},
    logError: (line) => errors.push(line),
    alert: async () => false,
    schedule: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
  });
  const item = { name: "TML review bot", env: "JOB_TML_REVIEW_BOT_ENABLED" };

  supervisor.start(item);
  for (let attempt = 0; attempt < LONG_LIVED_MAX_CONSECUTIVE_RESTARTS; attempt += 1) {
    children.at(-1).emit("exit", 1, null);
    scheduled.at(-1).callback();
  }
  children.at(-1).emit("exit", 1, null);
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(errors.includes(
    "worker: ALERT_DELIVERY_FAILED job=TML review bot event=REVIEW_BOT_CRASH_LOOP",
  ));
});
