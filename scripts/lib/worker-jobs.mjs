import { readEnabledFlag } from "./env.mjs";

export const WORKER_TIME_ZONE = "Asia/Hong_Kong";

// Ported from the Windows Task Scheduler triggers recorded in the project:
// preflight 08:00 daily; catchup every 2h; all generation Thu 18:00;
// Sunmood/Bright Day scheduling Sun 18:00; FB top-up 09:30; IG daily 10:05.
export const SCHEDULED_JOBS = Object.freeze([
  {
    name: "SCE-Preflight",
    env: "JOB_SCE_PREFLIGHT_ENABLED",
    cron: "0 8 * * *",
    entry: "scripts/preflight.mjs",
    publisher: false,
    maxRuntimeMs: 10 * 60_000,
  },
  {
    name: "SCE-Catchup",
    env: "JOB_SCE_CATCHUP_ENABLED",
    cron: "0 */2 * * *",
    entry: "scripts/catchup.mjs",
    publisher: false,
    maxRuntimeMs: 55 * 60_000,
  },
  // Replaces the four divorce-tenant *-WeeklyAutopilot jobs removed in the 2026-08-25 prune.
  {
    name: "OwlStandard-WeeklyAutopilot",
    env: "JOB_OWL_STANDARD_WEEKLY_AUTOPILOT_ENABLED",
    cron: "0 18 * * 4",
    entry: "scripts/owl-standard/weekly-run.mjs",
    publisher: false,
    maxRuntimeMs: 35 * 60_000,
    // heavy: subject to MAX_CONCURRENT_HEAVY_JOBS. It generates 3 posts (3 image renders) on a 512MB
    // worker, which is the memory profile that cap exists for.
    heavy: true,
  },
  // SCE-Gatekeeper removed 2026-09-18 (moved to _archive/): it read the WINDOWS Task Scheduler and
  // judged coverage by MONDAYS — on Render, for a Tue/Wed/Fri brand, it could only raise false alarms.
  // Sunmood/BrightDay-AutoSchedule and TML/BetterLife-IG-Daily removed for the same reason as the weekly
  // autopilots above — divorce-tenant-only entries pointing at now-deleted files.
  {
    name: "SCE-FB-Topup",
    env: "JOB_SCE_FB_TOPUP_ENABLED",
    cron: "30 9 * * *",
    entry: "scripts/fb-topup.mjs",
    publisher: true,
    maxRuntimeMs: 15 * 60_000,
  },
  {
    // Owl Standard is IG-enabled (companies/owl-standard/company.md instagram.enabled: true), and
    // CLAUDE.md's hard rule is that an IG-enabled tenant publishes to FB *and* IG. FB scheduling is
    // native (api-schedule.mjs books scheduled_publish_time); IG has no native scheduling, so this job
    // publishes that day's already-approved post at post time. Fails closed without
    // IG_USER_ID_OWLSTANDARD / FB_PAGE_TOKEN_OWLSTANDARD, which are not set yet.
    name: "OwlStandard-IG-Daily",
    env: "JOB_OWL_STANDARD_IG_DAILY_ENABLED",
    cron: "5 10 * * *",
    entry: "scripts/owl-standard/api-ig-daily.mjs",
    publisher: true,
    maxRuntimeMs: 5 * 60_000,
  },
  {
    // Looks at every upcoming poster and withholds the broken ones. This is the only check in the
    // engine that inspects the PICTURE rather than the pipeline — see scripts/lib/poster-qa.mjs for
    // why (the image model is the only stochastic component, and a green exit code cannot see a
    // three-handed mascot or a garbled button).
    //
    // publisher: false — it never posts. It writes post.error, which publishable.mjs already treats
    // as unpublishable, so a defective poster is withheld rather than deleted.
    //
    // 06:00 daily, deliberately AHEAD of SCE-FB-Topup (09:30): a poster must be judged before the
    // job that would book it runs, or the check arrives too late to matter.
    name: "SCE-PosterQA",
    env: "JOB_SCE_POSTER_QA_ENABLED",
    cron: "0 6 * * *",
    entry: "scripts/poster-qa-sweep.mjs",
    publisher: false,
    maxRuntimeMs: 20 * 60_000,
  },
  {
    // THE REPAIR LAYER (2026-08-04). Everything else in this table DOES, DETECTS or ESCALATES;
    // nothing REPAIRED, so a fail-closed block stayed closed until the owner opened it by hand.
    //
    // Hourly, not daily: the two things it resolves — a stuck publish ledger slot and a post left
    // broken by a provider outage — both block the next scheduled publish, and a daily cadence means
    // up to 24 h of a client's page silently not being fed for a fault the machine can already fix.
    // It is cheap when there is nothing to do (one Graph read per stuck slot, none at all otherwise).
    //
    // publisher: false — it never posts. It resolves the LEDGER (confirm/release) and regenerates
    // withheld content; the actual publishing stays with the publisher jobs and their own gates.
    // That distinction is load-bearing: were it publisher:true it would be frozen by
    // PUBLISHING_ENABLED, which is exactly when a stuck slot most needs clearing.
    //
    // 15 minutes: the ledger pass is network-bound and small; the content pass is bounded by
    // CONTENT_REPAIR_DAILY_CAP and skips entirely when the writing provider is down.
    name: "SCE-Repair",
    env: "JOB_SCE_REPAIR_ENABLED",
    cron: "20 * * * *",
    entry: "scripts/repair.mjs",
    publisher: false,
    maxRuntimeMs: 15 * 60_000,
  },
  {
    // Exports every upcoming poster to Cloudinary and prints one json line per post, so all four
    // brands can be reviewed on ONE page. Without it the posters exist only on this worker's disk
    // and in four separate Telegram chats, which is not a reviewable form for a month of content.
    //
    // publisher: false — it never posts to Facebook or Instagram and never changes a post's status.
    // Its only side effect is an upload into a Cloudinary review folder.
    //
    // The cron is a deliberate near-never: this is meant to be fired on
    // demand with RUN_JOB_ONCE=SCE-ContactSheet, not scheduled. 10 minutes covers ~40 posts with
    // headroom; each upload has its own 2-minute deadline.
    name: "SCE-ContactSheet",
    env: "JOB_SCE_CONTACT_SHEET_ENABLED",
    cron: "0 4 2 1 *",
    entry: "scripts/contact-sheet.mjs",
    publisher: false,
    maxRuntimeMs: 10 * 60_000,
  },
]);

// DEFECT 3 (2026-07-31 adversarial review): all four *-WeeklyAutopilot jobs share
// the cron "0 18 * * 4" — every Thursday at 18:00 HKT they are all DUE in the same
// minute, and scripts/lib/scheduled-job-runtime.mjs previously prevented overlap
// only by exact job NAME, so nothing stopped all four from starting together. On a
// 512MB Render worker, four simultaneous brand-generation runs (each its own Node
// process, each potentially touching Playwright/Sharp/image APIs) is a real OOM
// risk that would hit all four live brands at once.
//
// This caps how many `heavy: true` jobs may run AT THE SAME TIME; it does not
// touch anything else — frequent light jobs are deliberately exempt so they can
// never be starved by a long heavy window. A heavy job that is due but over
// capacity is DEFERRED (scripts/lib/worker-job-runtime.mjs keeps retrying it on
// every tick, not just within its one-minute cron window) until a slot frees —
// bounded by the slowest heavy job's own 35-minute maxRuntimeMs, never unbounded.
export const MAX_CONCURRENT_HEAVY_JOBS = 2;

// TML/Sunmood/BrightDay review bots removed — this checkout was pruned to Owl Standard only and their
// per-brand scripts/<tenant>/tg-bridge.mjs entries no longer exist. The remaining entry points at the
// SHARED scripts/tg-bridge.mjs (still present) — relabelled for Owl Standard so it's ready to wire once
// TELEGRAM_BOT_TOKEN_OWLSTANDARD / FB_PAGE_TOKEN_OWLSTANDARD are set in secrets/owl-standard/.env. It stays
// off by default (JOB_OWL_STANDARD_REVIEW_BOT_ENABLED unset), same as every other job here.
export const REVIEW_BOTS = Object.freeze([
  {
    name: "Owl Standard review bot",
    brand: "owl-standard",
    env: "JOB_OWL_STANDARD_REVIEW_BOT_ENABLED",
    tokenEnv: "TELEGRAM_BOT_TOKEN_OWLSTANDARD",
    fbTokenEnv: "FB_PAGE_TOKEN_OWLSTANDARD",
    entry: "scripts/tg-bridge.mjs",
  },
]);

export function enabled(item, options) {
  return readEnabledFlag(item.env, options);
}

function matchPart(part, value) {
  if (part === "*") return true;
  const step = part.match(/^\*\/(\d+)$/);
  if (step) return Number(step[1]) > 0 && value % Number(step[1]) === 0;
  return part.split(",").some((candidate) => Number(candidate) === value);
}

export function zonedMinute(date, timeZone = WORKER_TIME_ZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    dow,
    key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`,
  };
}

export function cronMatches(cron, minute) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid five-field cron expression: ${cron}`);
  return fields.every((part, index) =>
    matchPart(part, [minute.minute, minute.hour, minute.day, minute.month, minute.dow][index]));
}
