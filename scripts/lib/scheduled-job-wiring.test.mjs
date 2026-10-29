import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const worker = readFileSync(
  fileURLToPath(new URL("../render-worker.mjs", import.meta.url)),
  "utf8",
);
const runtime = readFileSync(
  fileURLToPath(new URL("./worker-job-runtime.mjs", import.meta.url)),
  "utf8",
);

test("Render worker gives cron and RUN_JOB_ONCE the same max-runtime supervisor", () => {
  assert.match(worker, /createScheduledJobSupervisor/);
  assert.match(worker, /createWorkerJobRuntime/);
  assert.match(worker, /jobs:\s*SCHEDULED_JOBS/);
  assert.match(worker, /supervisor:\s*scheduledSupervisor/);
  assert.match(worker, /\[resolve\(cwd,\s*item\.entry\),\s*\.\.\.\(item\.args \|\| \[\]\)\]/);
  assert.match(worker, /workerJobRuntime\.triggerRunOnce\(getEnv\(RUN_JOB_ONCE_ENV\)\)/);
  assert.match(worker, /workerJobRuntime\.tick/);
  assert.match(
    worker,
    /if \(!runOnce\.schedulerAllowed\)[\s\S]*process\.exitCode = 1;[\s\S]*else \{[\s\S]*await startSchedulerAndBots\(\)/,
  );
  assert.match(runtime, /function runScheduled/);
  assert.match(runtime, /supervisor\.start\(job,\s*\{\s*onExit\s*\}\)/);
  // tick() resolves a per-job `slot` (either the current minute, or the ORIGINAL
  // slot a heavy job was deferred for — see the DEFECT 3 concurrency guard) and
  // passes it to runScheduled; it is no longer always literally `minute.key`.
  assert.match(runtime, /const result = runScheduled\(job,\s*slot\)/);
  assert.match(runtime, /runScheduled\(job,\s*slot,\s*\{/);
  assert.match(worker, /scheduledSupervisor\.stopAll\("SIGTERM"\)/);
  assert.match(worker, /alert:\s*escalate/);
  assert.match(worker, /resolveAlert/);
});
