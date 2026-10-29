import { isIdempotentNoopExit } from "./process-outcome.mjs";

export const RUN_JOB_ONCE_ENV = "RUN_JOB_ONCE";

// DEFECT 3 (2026-07-31 adversarial review): default cap on how many `job.heavy`
// scheduled jobs may run at once. See the comment on MAX_CONCURRENT_HEAVY_JOBS in
// scripts/lib/worker-jobs.mjs for why this exists and why it is only ever applied
// to jobs explicitly opted in via `heavy: true` — Golf-Notion-Feedback is
// deliberately NOT subject to it. Exported so a caller can assert this module's
// own default matches the policy constant instead of trusting two numbers to stay
// in sync by hand.
export const DEFAULT_MAX_CONCURRENT_HEAVY_JOBS = 2;

function formatResultValue(value) {
  return JSON.stringify(value ?? null);
}

export function createWorkerJobRuntime({
  jobs,
  supervisor,
  isEnabled,
  readPostingControl,
  cronMatches,
  zonedMinute,
  log = console.log,
  logError = console.error,
  maxConcurrentHeavy = DEFAULT_MAX_CONCURRENT_HEAVY_JOBS,
} = {}) {
  if (!Array.isArray(jobs) || !supervisor || typeof supervisor.start !== "function") {
    throw new TypeError("worker job runtime requires jobs and a scheduled supervisor");
  }
  if (
    typeof isEnabled !== "function" ||
    typeof readPostingControl !== "function" ||
    typeof cronMatches !== "function" ||
    typeof zonedMinute !== "function"
  ) {
    throw new TypeError("worker job runtime requires enable, posting-control, cron, and timezone functions");
  }
  if (!Number.isFinite(maxConcurrentHeavy) || maxConcurrentHeavy < 1) {
    throw new TypeError("worker job runtime requires a positive maxConcurrentHeavy");
  }

  const lastSlots = new Map();
  // Cron-due heavy jobs that were deferred because MAX_CONCURRENT_HEAVY_JOBS was
  // already in use. Keyed by job name -> the ORIGINAL slot key they were due for.
  // tick() keeps retrying every entry here on every 15s tick — not just within the
  // one-minute window their cron matched — so a heavy job blocked at Thursday
  // 18:00 keeps trying at 18:03, 18:17, wherever a slot actually frees, instead of
  // silently missing its only cron match of the week.
  const deferredHeavy = new Map();
  let runOnceConsumed = false;

  function runningHeavyCount() {
    let count = 0;
    for (const job of jobs) {
      if (job.heavy && supervisor.has(job.name)) count += 1;
    }
    return count;
  }

  function logRunOnceResult(job, {
    exitCode,
    brake,
    status,
    childStarted,
    jobEnabled,
    signal = "none",
  }) {
    log(
      `RUN_JOB_ONCE_RESULT job=${formatResultValue(job.name)} exit_code=${formatResultValue(exitCode)} ` +
      `brake=${brake} status=${status} child_started=${childStarted} ` +
      `job_enabled=${jobEnabled} signal=${signal}`,
    );
    log(`RUN_JOB_ONCE_END job=${formatResultValue(job.name)}`);
  }

  function runScheduled(job, slot, {
    source = "cron",
    jobEnabled = true,
  } = {}) {
    const isRunOnce = source === "run_job_once";
    if (isRunOnce) lastSlots.set(job.name, slot);

    if (supervisor.has(job.name)) {
      log(`worker: skip ${job.name}; previous run still active`);
      if (isRunOnce) {
        logRunOnceResult(job, {
          exitCode: null,
          brake: job.publisher ? "not_checked" : "not_applicable",
          status: "already_active",
          childStarted: false,
          jobEnabled,
        });
      }
      return { started: false, status: "already_active" };
    }

    if (job.heavy && runningHeavyCount() >= maxConcurrentHeavy) {
      log(`worker: defer ${job.name}; ${maxConcurrentHeavy} heavy job(s) already running`);
      if (isRunOnce) {
        logRunOnceResult(job, {
          exitCode: null,
          brake: job.publisher ? "not_checked" : "not_applicable",
          status: "heavy_capacity",
          childStarted: false,
          jobEnabled,
        });
      }
      return { started: false, status: "heavy_capacity" };
    }

    let posting = null;
    if (job.publisher) {
      posting = readPostingControl();
      if (!posting.enabled) {
        log(`worker: skip ${job.name}; publishing brake=${posting.kind}`);
        if (isRunOnce) {
          logRunOnceResult(job, {
            exitCode: null,
            brake: posting.kind,
            status: "blocked",
            childStarted: false,
            jobEnabled,
          });
        }
        return { started: false, status: "blocked", brake: posting.kind };
      }
    }

    // RUN_JOB_ONCE is an execution request, not authorisation. A disabled
    // publisher still traverses the real posting-control check above so an
    // operator can rehearse either brake, but clear brakes never let the
    // trigger override the job's own JOB_*_ENABLED flag.
    if (isRunOnce && !jobEnabled) {
      log(`worker: skip ${job.name}; ${job.env} is disabled after brake check`);
      logRunOnceResult(job, {
        exitCode: null,
        brake: job.publisher ? "enabled" : "not_applicable",
        status: "job_disabled",
        childStarted: false,
        jobEnabled,
      });
      return { started: false, status: "job_disabled", brake: posting?.kind };
    }

    lastSlots.set(job.name, slot);
    const onExit = isRunOnce
      ? ({ code, signal, idempotentNoop = isIdempotentNoopExit(code) }) => {
          logRunOnceResult(job, {
            exitCode: code,
            brake: job.publisher && code === 0 ? "published" : (posting?.kind || "not_applicable"),
            status: idempotentNoop ? "no_op" : (code === 0 ? "completed" : "failed"),
            childStarted: true,
            jobEnabled,
            signal: signal ?? "none",
          });
        }
      : undefined;
    const child = supervisor.start(job, { onExit });
    return { started: true, status: "started", child };
  }

  function tick(now = new Date()) {
    const minute = zonedMinute(now);
    for (const job of jobs) {
      if (!isEnabled(job)) {
        deferredHeavy.delete(job.name);
        continue;
      }
      const dueNow = cronMatches(job.cron, minute) && lastSlots.get(job.name) !== minute.key;
      const deferredSlot = deferredHeavy.get(job.name);
      if (!dueNow && deferredSlot === undefined) continue;
      // A job already deferred for an earlier slot keeps retrying for THAT slot;
      // it does not re-arm just because its cron happens to match again while
      // still waiting (not reachable for the once-a-week heavy jobs today, but
      // keeps the logic correct if that ever changes).
      const slot = deferredSlot !== undefined ? deferredSlot : minute.key;
      const result = runScheduled(job, slot);
      if (result.status === "heavy_capacity") deferredHeavy.set(job.name, slot);
      else deferredHeavy.delete(job.name);
    }
  }

  function triggerRunOnce(name, now = new Date()) {
    if (!name) return { requested: false, schedulerAllowed: true };
    if (runOnceConsumed) {
      logError(`worker: RUN_JOB_ONCE_ALREADY_CONSUMED name=${formatResultValue(name)}`);
      return { requested: true, schedulerAllowed: true, consumed: true };
    }
    runOnceConsumed = true;

    const job = jobs.find((candidate) => candidate.name === name);
    if (!job) {
      logError(
        `worker: RUN_JOB_ONCE_UNKNOWN name=${formatResultValue(name)} ` +
        "scheduler_not_started=true",
      );
      return { requested: true, schedulerAllowed: false, unknown: true };
    }

    const jobEnabled = isEnabled(job);
    const slot = zonedMinute(now).key;
    log(
      `RUN_JOB_ONCE_BEGIN job=${formatResultValue(job.name)} ` +
      `job_enabled=${jobEnabled} publisher=${Boolean(job.publisher)}`,
    );
    const result = runScheduled(job, slot, {
      source: "run_job_once",
      jobEnabled,
    });
    return {
      requested: true,
      schedulerAllowed: true,
      job,
      result,
    };
  }

  return {
    lastSlots,
    runScheduled,
    tick,
    triggerRunOnce,
  };
}
