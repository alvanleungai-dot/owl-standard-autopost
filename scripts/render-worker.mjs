// One Render worker owns all cloud-movable schedules and review bots.
// Every task is fail-closed behind an exact JOB_*_ENABLED=true flag.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { assertStateDir, configPath } from "./lib/paths.mjs";
import { assertSingleInstance, releaseSingleInstance } from "./lib/single-instance.mjs";
import { getEnv } from "./lib/env.mjs";
import { readPostingControl } from "./lib/publishable.mjs";
import { escalate, resolve as resolveAlert, OPS_TOKEN_ENV } from "./lib/alert.mjs";
import { ensureCjkFont } from "./lib/fonts.mjs";
import { createLongLivedSupervisor } from "./lib/long-lived-supervisor.mjs";
import { createScheduledJobSupervisor } from "./lib/scheduled-job-runtime.mjs";
import {
  createWorkerJobRuntime,
  RUN_JOB_ONCE_ENV,
} from "./lib/worker-job-runtime.mjs";
import {
  cronMatches,
  enabled,
  MAX_CONCURRENT_HEAVY_JOBS,
  REVIEW_BOTS,
  SCHEDULED_JOBS,
  WORKER_TIME_ZONE,
  zonedMinute,
} from "./lib/worker-jobs.mjs";
import { verifySeededState } from "./init-state-dir.mjs";

const root = assertStateDir();
const instanceLease = assertSingleInstance({ root }); // explicit runtime assertion; render.yaml is not a safety boundary.
const seeded = verifySeededState(root);
const cwd = configPath();
let stopping = false;

function spawnChild(item) {
  return spawn(process.execPath, [resolve(cwd, item.entry), ...(item.args || [])], {
    cwd,
    env: { ...process.env },
    stdio: "inherit",
    windowsHide: true,
    // detached: true makes this job the LEADER of its own new process group on
    // POSIX (pgid === its own pid). A job that itself spawns a grandchild
    // synchronously (Golf-Notion-Feedback's execFileSync call into
    // build-batch.mjs) leaves that grandchild in the SAME group, which is what
    // lets scripts/lib/process-tree-kill.mjs reach it with one `process.kill
    // (-pid, …)` call when the supervisor's maxRuntimeMs fires. Without this, a
    // killed job can orphan a still-running, still-paying grandchild — see
    // scripts/lib/process-tree-kill.mjs for the full incident writeup.
    detached: true,
  });
}

const botSupervisor = createLongLivedSupervisor({
  spawnChild,
  enabled,
  alert: escalate,
  isStopping: () => stopping,
});

const scheduledSupervisor = createScheduledJobSupervisor({
  spawnChild,
  alert: escalate,
  resolveAlert,
});

const workerJobRuntime = createWorkerJobRuntime({
  jobs: SCHEDULED_JOBS,
  supervisor: scheduledSupervisor,
  isEnabled: enabled,
  readPostingControl,
  cronMatches,
  zonedMinute,
  maxConcurrentHeavy: MAX_CONCURRENT_HEAVY_JOBS,
});

for (const job of SCHEDULED_JOBS) {
  console.log(
    `worker job: ${job.name} ${enabled(job) ? "ENABLED" : "DISABLED"} ` +
    `flag=${job.env} cron="${job.cron}" tz=${WORKER_TIME_ZONE}${job.publisher ? " publisher=true" : ""}`,
  );
}

// FONTS BEFORE ANY JOB CAN SPAWN. This sat inside startSchedulerAndBots() for exactly one deploy,
// which runs AFTER triggerRunOnce below — so the first RUN_JOB_ONCE=SCE-PosterQA started 55ms before
// the font environment existed, redrew a poster without it, and reported the identical garbling.
// Caught only because the fix was verified on the real path instead of assumed. Env set here is
// inherited by every descendant (worker -> weekly-run -> gen-week -> gen-poster).
const font = ensureCjkFont({ log: console.log });
console.log(font.ok ? `fonts: CJK ready (${font.reason})` : `FONTS_UNAVAILABLE: ${font.reason}`);

const runOnce = workerJobRuntime.triggerRunOnce(getEnv(RUN_JOB_ONCE_ENV));

// THE ALARM CHANNEL IS A STARTUP REQUIREMENT, NOT A RUNTIME CONVENIENCE (2026-08-04).
// The worker already refuses to start when a brand's dedicated review-bot token is missing (below).
// The ops bot deserves the same treatment and never had it: every safety alarm on this worker —
// failed job, stalled publish slot, undelivered review, crash loop, and now the repairer's
// "I could not fix this" — terminates in escalate(), and escalate() is worth exactly as much as
// this one token. Without the guard, a missing token degrades silently into log lines nobody reads,
// which is the precise failure mode the 2026-07-30 ALARM_SELFTEST block below was written to catch
// AFTER the fact. Better to refuse the boot: a worker that cannot shout is not safe to publish from.
function assertOpsAlarmChannel() {
  const missing = [OPS_TOKEN_ENV, "TELEGRAM_OWNER_CHAT_ID"].filter((key) => !getEnv(key));
  if (missing.length) {
    throw new Error(
      `refusing to start worker: ${missing.join(" + ")} missing, so no safety alarm could reach the owner. ` +
      `${OPS_TOKEN_ENV} is the DEDICATED ops bot — do not substitute a brand's token (see scripts/lib/alert.mjs).`,
    );
  }
}

async function startSchedulerAndBots() {
  assertOpsAlarmChannel();
  for (const bot of REVIEW_BOTS) {
    const isEnabled = enabled(bot);
    console.log(`worker job: ${bot.name} ${isEnabled ? "ENABLED" : "DISABLED"} flag=${bot.env} long_lived=true`);
    if (!isEnabled) continue;
    if (!getEnv(bot.tokenEnv)) {
      throw new Error(`${bot.env}=true but dedicated ${bot.tokenEnv} is missing; refusing to start worker.`);
    }
    botSupervisor.start(bot);
  }

  console.log(
    `Render worker ready; durable state root=${root}; brands=${seeded.brands}; ` +
    `manifests=${seeded.manifests}; pid=${process.pid}`,
  );

// ---- ALARM CHANNEL SELF-TEST (2026-07-30) --------------------------------------------------
// Fable's publisher gate named ONE residual risk that makes every other safety fix worthless:
// the job-failure alarm, the ledger reaper alarm, the review-delivery-failed alarm and the
// crash-loop alarm ALL terminate in escalate(), which reaches the owner only via the shared
// ops bot. Nothing asserted that TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID actually work
// from inside this container — the worker guards the four per-brand bot tokens but not this
// one. If either were wrong, all four fixes would silently become log lines nobody reads.
//
// The obvious way to check — a Render one-off job running `preflight.mjs --report` — CANNOT
// work: one-off jobs do not mount the persistent disk, so the durability sentinel is absent
// and paths.mjs correctly refuses (verified 2026-07-30, job-d9lefd6417fc73co7gp0 failed with
// StateDirError). The disk is only mounted in THIS process. So the self-test belongs here.
//
// Set ALARM_SELFTEST=1 for one deploy to prove the channel end to end, then remove it. It is
// deliberately opt-in and one-shot: an alarm that fires on every boot trains the owner to
// ignore alarms, which is the failure mode this whole exercise exists to prevent.
if (getEnv("ALARM_SELFTEST") === "1") {
  const { escalate } = await import("./lib/alert.mjs");
  const delivered = await escalate({
    source: "worker",
    kind: `alarm-selftest:${new Date().toISOString().slice(0, 16)}`,
    severity: "crucial",
    text:
      "✅ Alarm channel self-test from the Render worker. If you are reading this, every " +
      "safety alarm (failed job, stalled publish slot, undelivered review, crash loop) can " +
      "reach you. Nothing is wrong — this was requested deliberately.",
  });
  // Report the RESULT, not the attempt. escalate() was fixed on 2026-07-30 precisely because
  // it used to log "SENT to owner" whether or not Telegram accepted.
  console.log(
    delivered
      ? "ALARM_SELFTEST=delivered — the owner alarm channel works from this container"
      : "ALARM_SELFTEST=FAILED — escalate() could not deliver. Every safety alarm is currently " +
        "a log line nobody reads. Do NOT enable any publisher until this is fixed.",
  );
}

workerJobRuntime.tick();
const schedulerTimer = setInterval(workerJobRuntime.tick, 15_000);
const leaseTimer = setInterval(() => {
  try {
    assertSingleInstance({ root });
  } catch (error) {
    console.error(`Render worker lost the single-instance lease: ${error.message}`);
    process.exit(1);
  }
}, 60_000);

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`worker: shutting down on ${signal}`);
  clearInterval(schedulerTimer);
  clearInterval(leaseTimer);
  scheduledSupervisor.stopAll("SIGTERM");
  botSupervisor.stopAll("SIGTERM");
  try {
    const released = releaseSingleInstance({ root, lease: instanceLease });
    console.log(`worker: single-instance lease ${released ? "released" : "not released (ownership changed)"}`);
  } catch (error) {
    console.error(`worker: single-instance lease release failed: ${error.message}`);
  }
  setTimeout(() => process.exit(0), 1_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
}

if (!runOnce.schedulerAllowed) {
  try {
    const released = releaseSingleInstance({ root, lease: instanceLease });
    console.error(
      `worker: scheduler startup aborted; single-instance lease ` +
      `${released ? "released" : "not released (ownership changed)"}`,
    );
  } catch (error) {
    console.error(`worker: startup-abort lease release failed: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  await startSchedulerAndBots();
}
