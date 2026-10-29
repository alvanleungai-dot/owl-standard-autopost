import test from "node:test";
import assert from "node:assert/strict";
import { readPostingControl } from "./publishable.mjs";
import { createWorkerJobRuntime, DEFAULT_MAX_CONCURRENT_HEAVY_JOBS } from "./worker-job-runtime.mjs";
import { IDEMPOTENT_NOOP_EXIT_CODE } from "./process-outcome.mjs";
import { MAX_CONCURRENT_HEAVY_JOBS } from "./worker-jobs.mjs";

const NOW = new Date("2026-07-30T10:00:00.000Z");
const MINUTE = {
  minute: 0,
  hour: 18,
  day: 30,
  month: 7,
  dow: 4,
  key: "2026-07-30T18:00",
};

function postingControl({ publishingEnabled = false, frozen = false } = {}) {
  return readPostingControl({
    env: {
      CLOUD: "1",
      STATE_DIR: "/durable",
      ...(publishingEnabled ? { PUBLISHING_ENABLED: "1" } : {}),
    },
    stat: (path) => {
      if (String(path).endsWith("secrets")) return {};
      if (String(path).endsWith("POSTING_FROZEN") && frozen) return {};
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
    read: () => "operator rehearsal",
  });
}

function harness({
  jobs,
  enabledNames = [],
  control = postingControl(),
  supervisor,
} = {}) {
  const starts = [];
  const logs = [];
  const errors = [];
  const scheduledSupervisor = supervisor || {
    has: () => false,
    start: (job, options) => {
      const child = { pid: 4321 };
      starts.push({ job, options, child });
      return child;
    },
  };
  const runtime = createWorkerJobRuntime({
    jobs,
    supervisor: scheduledSupervisor,
    isEnabled: (job) => enabledNames.includes(job.name),
    readPostingControl: () => control,
    cronMatches: () => true,
    zonedMinute: () => MINUTE,
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  });
  return { runtime, starts, logs, errors, supervisor: scheduledSupervisor };
}

const publisher = Object.freeze({
  name: "Sunmood-AutoSchedule",
  env: "JOB_SUNMOOD_AUTO_SCHEDULE_ENABLED",
  cron: "0 18 * * 0",
  entry: "scripts/sunmood/api-schedule.mjs",
  publisher: true,
  maxRuntimeMs: 5 * 60_000,
});

test("unknown RUN_JOB_ONCE fails loudly and prevents scheduler startup", () => {
  const { runtime, starts, errors } = harness({ jobs: [publisher] });
  const result = runtime.triggerRunOnce("Sunmood-AutoScheduel", NOW);
  let schedulerStarts = 0;
  if (result.schedulerAllowed) schedulerStarts++;

  assert.equal(result.unknown, true);
  assert.equal(result.schedulerAllowed, false);
  assert.equal(schedulerStarts, 0);
  assert.equal(starts.length, 0);
  assert.match(errors.join("\n"), /RUN_JOB_ONCE_UNKNOWN.*Sunmood-AutoScheduel.*scheduler_not_started=true/);
});

test("disabled publisher trigger reaches cloud_not_enabled brake and never starts a child", () => {
  const { runtime, starts, logs } = harness({
    jobs: [publisher],
    control: postingControl(),
  });

  const result = runtime.triggerRunOnce(publisher.name, NOW);

  assert.equal(result.result.brake, "cloud_not_enabled");
  assert.equal(starts.length, 0);
  assert.match(logs.join("\n"), /publishing brake=cloud_not_enabled/);
  assert.match(
    logs.join("\n"),
    /RUN_JOB_ONCE_RESULT.*exit_code=null.*brake=cloud_not_enabled.*child_started=false.*job_enabled=false/,
  );
});

test("disabled publisher trigger reaches frozen brake with positive cloud signal and never publishes", () => {
  const { runtime, starts, logs } = harness({
    jobs: [publisher],
    control: postingControl({ publishingEnabled: true, frozen: true }),
  });

  const result = runtime.triggerRunOnce(publisher.name, NOW);

  assert.equal(result.result.brake, "frozen");
  assert.equal(starts.length, 0);
  assert.match(logs.join("\n"), /publishing brake=frozen/);
  assert.match(logs.join("\n"), /RUN_JOB_ONCE_RESULT.*brake=frozen.*status=blocked/);
});

test("clear brakes cannot let RUN_JOB_ONCE override a disabled publisher flag", () => {
  const { runtime, starts, logs } = harness({
    jobs: [publisher],
    control: postingControl({ publishingEnabled: true }),
  });

  runtime.triggerRunOnce(publisher.name, NOW);

  assert.equal(starts.length, 0);
  assert.match(logs.join("\n"), /JOB_SUNMOOD_AUTO_SCHEDULE_ENABLED is disabled after brake check/);
  assert.match(logs.join("\n"), /brake=enabled status=job_disabled.*child_started=false/);
});

test("trigger is consumed once and does nothing while unset", () => {
  const job = { ...publisher, publisher: false };
  const { runtime, starts, errors } = harness({
    jobs: [job],
    enabledNames: [job.name],
  });

  assert.deepEqual(runtime.triggerRunOnce("", NOW), {
    requested: false,
    schedulerAllowed: true,
  });
  assert.equal(starts.length, 0);

  runtime.triggerRunOnce(job.name, NOW);
  runtime.tick(NOW);
  runtime.triggerRunOnce(job.name, NOW);

  assert.equal(starts.length, 1);
  assert.match(errors.join("\n"), /RUN_JOB_ONCE_ALREADY_CONSUMED/);
});

test("cron and RUN_JOB_ONCE both enter the same supervisor with the registered runtime cap", () => {
  const starts = [];
  const sharedSupervisor = {
    has: () => false,
    start: (job, options) => {
      starts.push({ job, options });
      return { pid: 4321 };
    },
  };
  const job = { ...publisher, publisher: false };
  const { runtime } = harness({
    jobs: [job],
    enabledNames: [job.name],
    supervisor: sharedSupervisor,
  });

  runtime.tick(NOW);
  runtime.triggerRunOnce(job.name, NOW);

  assert.equal(starts.length, 2);
  assert.strictEqual(starts[0].job, job);
  assert.strictEqual(starts[1].job, job);
  assert.equal(starts[0].job.maxRuntimeMs, 5 * 60_000);
  assert.equal(starts[1].job.maxRuntimeMs, 5 * 60_000);
  assert.equal(starts[0].options.onExit, undefined);
  assert.equal(typeof starts[1].options.onExit, "function");
});

test("enabled publisher completion reports its supervised exit code and published verdict", () => {
  const { runtime, starts, logs } = harness({
    jobs: [publisher],
    enabledNames: [publisher.name],
    control: postingControl({ publishingEnabled: true }),
  });

  runtime.triggerRunOnce(publisher.name, NOW);
  starts[0].options.onExit({ code: 0, signal: null });

  assert.equal(starts.length, 1);
  assert.match(
    logs.join("\n"),
    /RUN_JOB_ONCE_RESULT.*exit_code=0.*brake=published.*status=completed.*child_started=true/,
  );
  assert.match(logs.join("\n"), /RUN_JOB_ONCE_END job="Sunmood-AutoSchedule"/);
});

test("RUN_JOB_ONCE reports an idempotent exit as no_op instead of failed", () => {
  const job = { ...publisher, name: "WeeklyAutopilot", publisher: false };
  const { runtime, starts, logs } = harness({
    jobs: [job],
    enabledNames: [job.name],
  });

  runtime.triggerRunOnce(job.name, NOW);
  starts[0].options.onExit({
    code: IDEMPOTENT_NOOP_EXIT_CODE,
    signal: null,
    idempotentNoop: true,
  });

  assert.match(
    logs.join("\n"),
    new RegExp(`RUN_JOB_ONCE_RESULT.*exit_code=${IDEMPOTENT_NOOP_EXIT_CODE}.*status=no_op`),
  );
  assert.doesNotMatch(logs.join("\n"), /status=failed/);
});

// ─── DEFECT 3 (2026-07-31 adversarial review): heavy-job concurrency guard ─────
// All four *-WeeklyAutopilot jobs share the cron "0 18 * * 4" and could previously
// all start together on a 512MB Render worker with no ceiling but "not the exact
// same job name". These tests exercise the `job.heavy` concurrency cap directly
// against a small fake supervisor that actually tracks which named jobs are
// "running", so `runningHeavyCount()` has something real to count.

function heavyJob(name, overrides = {}) {
  return {
    name,
    env: `JOB_${name.toUpperCase()}_ENABLED`,
    cron: "0 18 * * 4",
    entry: `scripts/${name}/weekly-run.mjs`,
    publisher: false,
    maxRuntimeMs: 35 * 60_000,
    heavy: true,
    ...overrides,
  };
}

function trackingSupervisor() {
  const runningNames = new Set();
  const starts = [];
  return {
    runningNames,
    starts,
    has: (name) => runningNames.has(name),
    start: (job, options) => {
      runningNames.add(job.name);
      const child = { pid: 1000 + starts.length };
      starts.push({ job, options, child });
      return child;
    },
    finish: (name) => runningNames.delete(name),
  };
}

test("MAX_CONCURRENT_HEAVY_JOBS (worker-jobs.mjs) and this module's own default agree", () => {
  // Two numbers that must never drift apart silently: worker-jobs.mjs documents
  // and exports the POLICY value; render-worker.mjs passes it explicitly; this
  // module's own default only exists so a caller that forgets to pass it is still
  // protected. If they disagree, something changed one without the other.
  assert.equal(DEFAULT_MAX_CONCURRENT_HEAVY_JOBS, MAX_CONCURRENT_HEAVY_JOBS);
});

test("createWorkerJobRuntime rejects a non-positive maxConcurrentHeavy", () => {
  const supervisor = trackingSupervisor();
  for (const bad of [0, -1, NaN, Infinity, "2"]) {
    assert.throws(() => createWorkerJobRuntime({
      jobs: [],
      supervisor,
      isEnabled: () => true,
      readPostingControl: () => ({ enabled: true }),
      cronMatches: () => true,
      zonedMinute: () => MINUTE,
      maxConcurrentHeavy: bad,
    }), TypeError, `expected a throw for maxConcurrentHeavy=${bad}`);
  }
});

test("a due heavy job over capacity is deferred, not skipped — and starts once a slot frees", () => {
  const supervisor = trackingSupervisor();
  const jobs = [heavyJob("Alpha-WeeklyAutopilot"), heavyJob("Beta-WeeklyAutopilot")];
  const runtime = createWorkerJobRuntime({
    jobs,
    supervisor,
    isEnabled: () => true,
    readPostingControl: () => { throw new Error("must not be consulted for a non-publisher"); },
    cronMatches: () => true, // both jobs are "due" every tick in this test
    zonedMinute: () => MINUTE,
    maxConcurrentHeavy: 1,
    log: () => {},
    logError: () => {},
  });

  runtime.tick(NOW);
  assert.deepEqual([...supervisor.runningNames], ["Alpha-WeeklyAutopilot"]);
  assert.equal(supervisor.starts.length, 1, "only one heavy slot exists");

  // Beta keeps being deferred on subsequent ticks — it must NOT be silently
  // dropped just because it is no longer inside its original one-minute cron
  // match (cronMatches stays true here, but the deferred path does not depend on
  // that — see the next test for the case where it goes false).
  runtime.tick(NOW);
  runtime.tick(NOW);
  assert.equal(supervisor.starts.length, 1, "Beta must not start while Alpha holds the only heavy slot");

  // Alpha finishes; the freed slot goes to the still-deferred Beta on the very
  // next tick.
  supervisor.finish("Alpha-WeeklyAutopilot");
  runtime.tick(NOW);
  assert.deepEqual([...supervisor.runningNames], ["Beta-WeeklyAutopilot"]);
  assert.equal(supervisor.starts.length, 2);
  assert.equal(supervisor.starts[1].job.name, "Beta-WeeklyAutopilot");
});

test("a deferred heavy job keeps retrying even after its cron minute is no longer due", () => {
  const supervisor = trackingSupervisor();
  const jobs = [heavyJob("Alpha-WeeklyAutopilot"), heavyJob("Beta-WeeklyAutopilot")];
  let due = true;
  const runtime = createWorkerJobRuntime({
    jobs,
    supervisor,
    isEnabled: () => true,
    readPostingControl: () => { throw new Error("must not be consulted"); },
    cronMatches: () => due,
    zonedMinute: () => MINUTE,
    maxConcurrentHeavy: 1,
    log: () => {},
    logError: () => {},
  });

  runtime.tick(NOW); // Alpha takes the only slot, Beta is deferred
  assert.equal(supervisor.starts.length, 1);

  // The one-minute cron window that Beta was originally due in has now passed —
  // exactly the scenario that would silently swallow a heavy job's only weekly
  // trigger without the deferred-retry mechanism.
  due = false;
  runtime.tick(NOW);
  runtime.tick(NOW);
  assert.equal(supervisor.starts.length, 1, "still deferred, still remembered, not dropped");

  supervisor.finish("Alpha-WeeklyAutopilot");
  runtime.tick(NOW); // Beta still runs even though cronMatches() is now false
  assert.equal(supervisor.starts.length, 2);
  assert.equal(supervisor.starts[1].job.name, "Beta-WeeklyAutopilot");
});

test("the heavy-job cap never blocks a non-heavy job (golf must never starve)", () => {
  const supervisor = trackingSupervisor();
  const golf = {
    name: "Golf-Notion-Feedback",
    env: "JOB_GOLF_NOTION_FEEDBACK_ENABLED",
    cron: "*/2 * * * *",
    entry: "scripts/golf/watch-feedback.mjs",
    publisher: false,
    maxRuntimeMs: 10 * 60_000,
    // deliberately NOT heavy: true
  };
  const jobs = [heavyJob("Alpha-WeeklyAutopilot"), heavyJob("Beta-WeeklyAutopilot"), golf];
  const runtime = createWorkerJobRuntime({
    jobs,
    supervisor,
    isEnabled: () => true,
    readPostingControl: () => { throw new Error("must not be consulted"); },
    cronMatches: () => true,
    zonedMinute: () => MINUTE,
    maxConcurrentHeavy: 1, // both heavy jobs contend for a single slot
    log: () => {},
    logError: () => {},
  });

  runtime.tick(NOW);
  // Both heavy jobs contended for the one slot (only one of them started), but
  // golf — never counted against the heavy cap — always starts on schedule.
  assert.ok(supervisor.has("Golf-Notion-Feedback"), "golf must never be deferred by the heavy-job cap");
  const heavyRunning = jobs.filter((j) => j.heavy && supervisor.has(j.name));
  assert.equal(heavyRunning.length, 1);
});

test("disabling a deferred heavy job clears it, instead of starting it the moment it is re-enabled", () => {
  const supervisor = trackingSupervisor();
  const jobs = [heavyJob("Alpha-WeeklyAutopilot"), heavyJob("Beta-WeeklyAutopilot")];
  let betaEnabled = true;
  const runtime = createWorkerJobRuntime({
    jobs,
    supervisor,
    isEnabled: (job) => (job.name === "Beta-WeeklyAutopilot" ? betaEnabled : true),
    readPostingControl: () => { throw new Error("must not be consulted"); },
    cronMatches: () => true,
    zonedMinute: () => MINUTE,
    maxConcurrentHeavy: 1,
    log: () => {},
    logError: () => {},
  });

  runtime.tick(NOW); // Alpha takes the slot, Beta is due but deferred
  assert.equal(supervisor.starts.length, 1);

  betaEnabled = false;
  runtime.tick(NOW); // Beta is disabled mid-deferral — must be forgotten, not just paused
  supervisor.finish("Alpha-WeeklyAutopilot");
  runtime.tick(NOW);
  assert.equal(supervisor.starts.length, 1, "a disabled job must not silently start once re-enabled later");

  betaEnabled = true;
  runtime.tick(NOW); // only now, freshly due again, does it legitimately start
  assert.equal(supervisor.starts.length, 2);
});
