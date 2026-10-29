// scripts/fb-topup.mjs — weekly FB "top-up": re-runs each brand's api-schedule so backlog posts get
// scheduled the moment their Monday enters Facebook's ~30-day window. Idempotent (api-schedule skips posts
// that already have an fbPostId + dedups), so it's safe to run daily. Instagram is handled separately by
// the per-brand IG daily job (it follows post.date). node scripts/fb-topup.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { escalate, resolve } from "./lib/alert.mjs";

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const JOB_NAME = "SCE-FB-Topup";
const FAILURE_KIND = `job-failed:${JOB_NAME}`;

// Pruned to Owl Standard only — the four divorce tenants' schedulers were deleted with them.
// api-schedule.mjs only books status=approved posts (scripts/lib/publishable.mjs), so unattended top-up
// cannot publish anything the owner has not approved in Telegram first. It also fails closed when
// FB_PAGE_ID_OWLSTANDARD / FB_PAGE_TOKEN_OWLSTANDARD are unset, which they still are.
export const SCHEDULERS = Object.freeze([
  "owl-standard/api-schedule.mjs",
]);

export async function runTopup({
  schedulers = SCHEDULERS,
  runScheduler = (scheduler) => execFileSync(
    process.execPath,
    [p(scheduler)],
    { stdio: "inherit" },
  ),
  alert = escalate,
  resolveAlert = resolve,
  log = console.log,
} = {}) {
  const failures = [];
  for (const scheduler of schedulers) {
    log(`\n===== ${scheduler} =====`);
    try {
      runScheduler(scheduler);
    } catch (error) {
      const code = Number.isInteger(error?.status) ? error.status : null;
      failures.push({ scheduler, code });
      log(`(scheduler exited ${code ?? "?"})`);
    }
  }

  if (failures.length) {
    const summary = failures
      .map(({ scheduler, code }) => `${scheduler} (exit ${code ?? "unknown"})`)
      .join(", ");
    await alert({
      source: "render-worker",
      kind: FAILURE_KIND,
      severity: "crucial",
      text: `${JOB_NAME}: an approved post could not be booked on Facebook — ${summary}. See the worker log for the post and Meta's reason.`,
    });
    return { ok: false, exitCode: 1, failures };
  }

  resolveAlert("render-worker", FAILURE_KIND);
  return { ok: true, exitCode: 0, failures };
}

if (process.env.SCE_IMPORT_ONLY !== "1") {
  const result = await runTopup();
  if (!result.ok) process.exitCode = result.exitCode;
}
