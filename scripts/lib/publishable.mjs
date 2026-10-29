// scripts/lib/publishable.mjs — THE single answer to "may this post go live?"
//
// WHY THIS FILE EXISTS
// On 2026-07-20 the approval bug was fixed in the MANUAL scripts (schedule-week.mjs)
// and not in their CRON twins (api-schedule.mjs, api-ig-daily.mjs). The manual path
// looked correct while the unattended path — the one that actually runs at 09:30 with
// nobody watching — kept filtering on `status === "failed" || post.error` only.
//
// Measured 2026-07-21, what the cron path considered publishable:
//   tml         : 11 pending, 1 SKIP  ← a post the owner explicitly rejected
//   bright-day  : 5 pending (all of them)
//   sunmood     : 3 pending
//   better-life : 6 generated (never reviewed)
// and POSTING_FROZEN — the emergency kill-switch — was not consulted at all.
//
// These are LIVE CLIENT ACCOUNTS (a divorce firm, a medical clinic). The failure mode
// is not "a bad post"; it is publishing something the owner said NO to.
//
// THE RULE: every publisher — manual or cron — imports isPublishable() and
// assertNotFrozen(). scripts/task-health.mjs statically asserts that every
// scripts/**/api-*.mjs references this module, so a new publisher cannot be added
// without the gate. The CHECK is what survives; discipline is what failed.

import { statSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// ONE definition of "approved" for the whole engine. watchdog-core.mjs:7 already
// owned this predicate; adding a second copy here would have recreated the exact
// disease that caused the 2026-07-20 incident — a rule enforced in one copy of a
// path and silently diverging in the other. The status test is delegated, never
// duplicated; this module only adds the extra conditions publishing requires
// (freeze, dates, error records) on top of it.
import { isApproved as hasApprovedStatus } from "./watchdog-core.mjs";

/** The emergency kill-switch. Presence of this file = nothing may publish. */
export const FROZEN_PATH = fileURLToPath(new URL("../../secrets/POSTING_FROZEN", import.meta.url));
export const PUBLISHING_ENABLED_ENV = "PUBLISHING_ENABLED";

const isCloud = (env) => env.CLOUD === "1" || env.RENDER === "true";

export function postingFreezePath(env = process.env) {
  if (!isCloud(env)) return FROZEN_PATH;
  const stateDir = env.STATE_DIR?.trim();
  if (!stateDir) return null;
  return resolve(stateDir, "secrets", "POSTING_FROZEN");
}

export function readPostingControl({
  env = process.env,
  frozenPath,
  stat = statSync,
  read = readFileSync,
} = {}) {
  const controlPath = frozenPath ?? postingFreezePath(env);
  if (!controlPath) {
    return {
      enabled: false,
      kind: "control_unreadable",
      reason: "STATE_DIR is required to locate the cloud emergency-stop control",
      source: "STATE_DIR/secrets/POSTING_FROZEN",
    };
  }

  // init-state-dir creates this durable directory. If it disappears, ENOENT on the control file
  // is ambiguous ("not frozen" vs "the control surface was wiped"), so fail closed and name it.
  if (isCloud(env)) {
    try {
      stat(dirname(controlPath));
    } catch (error) {
      return {
        enabled: false,
        kind: "control_unreadable",
        reason: `emergency-stop directory unavailable: ${error?.code || error?.message || error}`,
        source: dirname(controlPath),
      };
    }
  }

  try {
    stat(controlPath);
    let reason = "";
    try { reason = read(controlPath, "utf8").trim(); }
    catch (error) {
      return {
        enabled: false,
        kind: "control_unreadable",
        reason: `emergency-stop file unreadable: ${error?.code || error?.message || error}`,
        source: controlPath,
      };
    }
    return { enabled: false, kind: "frozen", reason, source: controlPath };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return {
        enabled: false,
        kind: "control_unreadable",
        reason: `${error?.code || error?.message || error}`,
        source: controlPath,
      };
    }
  }

  // Render environment values survive checkout replacement. Requiring an exact
  // positive signal means a wiped filesystem can never enable publishing.
  if (isCloud(env) && env[PUBLISHING_ENABLED_ENV]?.trim() !== "1") {
    return {
      enabled: false,
      kind: "cloud_not_enabled",
      reason: `${PUBLISHING_ENABLED_ENV}=1 is required in cloud mode`,
      source: "environment",
    };
  }
  return { enabled: true, kind: "enabled", reason: "", source: isCloud(env) ? "environment" : "local-default" };
}

/**
 * Hard stop when posting is frozen. Call ONCE at the top of every publisher,
 * before any network call. `dry` runs are allowed through so previews still work.
 */
export function assertNotFrozen({ dry = false } = {}) {
  if (dry) return;
  const control = readPostingControl();
  if (control.enabled) return;
  if (control.kind === "frozen") {
    console.log(`⛔ POSTING FROZEN — refusing to publish.${control.reason ? `\n${control.reason}` : ""}`);
    // Exit 0: a deliberate freeze is not a fault, and a non-zero here would make
    // task-health "repair" a task that is behaving correctly. The trade-off is
    // that a frozen task reports healthy — so the freeze must stay observable
    // elsewhere (the sentinel file itself is the record).
    process.exit(0);
  }
  console.error(
    `⛔ Publishing control is not positively enabled (${control.kind}: ${control.reason}). ` +
      "Refusing to publish."
  );
  process.exit(1);
}

/**
 * The ONLY status that may go live. Explicit equality, never "not rejected":
 * on 2026-07-20 a post with NO status counted as approved and published.
 * Undecided is NOT consent. Timed auto-approval still works because
 * lib/review-core.mjs sets status="approved" explicitly when it fires.
 */
export const PUBLISHABLE_STATUS = "approved";

/**
 * May this post be published today?
 * @param {object} post  a post record from a companies/<brand>/weeks/*.json file
 * @param {string} today ISO date (YYYY-MM-DD) — the earliest date still schedulable
 */
export function isPublishable(post, today) {
  if (!post || typeof post !== "object") return false;
  if (!post.date || post.date < today) return false; // past or undated
  if (post.error) return false;
  return hasApprovedStatus(post);
}

/**
 * Approval + integrity only, WITHOUT any date rule.
 *
 * For publishers whose date logic is inverted: api-ig-daily posts what is DUE
 * (date <= today), while api-schedule schedules what is FUTURE (date >= today).
 * Sharing one date rule between them would silently break one of the two, so the
 * date stays with each caller and only the consent rule is centralised.
 */
export function isApproved(post) {
  if (!post || typeof post !== "object") return false;
  if (post.error) return false;
  return hasApprovedStatus(post);
}

/**
 * Meta accepts scheduled_publish_time only up to 30 days ahead. Keep a day of margin: anything
 * dated after lastBookableDate() is left for a later run instead of being sent (and rejected) daily.
 */
export const FB_BOOKING_WINDOW_DAYS = 29;
export function lastBookableDate(todayStr, days = FB_BOOKING_WINDOW_DAYS) {
  return new Date(Date.parse(`${todayStr}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Is this post due on Instagram now? Instagram MIRRORS Facebook: only on the post's own day (or the
 * day after, to recover a missed run), only when approved, and only once Facebook has it booked —
 * so Instagram never posts alone, and a job switched on late never dumps a backlog of old posts.
 */
export function instagramDue(post, todayStr, yesterdayStr) {
  if (!post?.date || post.date > todayStr) return { due: false, reason: "not due yet" };
  if (post.igPostId) return { due: false, reason: "already on Instagram" };
  if (post.date < yesterdayStr) return { due: false, reason: `missed its ${post.date} slot — not posting late` };
  if (!isApproved(post)) return { due: false, reason: whyNotPublishable(post, post.date) };
  if (!post.fbPostId) return { due: false, reason: "not booked on Facebook — Instagram never posts alone" };
  return { due: true, reason: "due" };
}

/** Human-readable reason a post was withheld — for honest logs, never for control flow. */
export function whyNotPublishable(post, today) {
  if (!post || typeof post !== "object") return "not a post record";
  if (!post.date) return "no date";
  if (post.date < today) return `date ${post.date} is in the past`;
  if (post.error) return `carries an error: ${String(post.error).slice(0, 60)}`;
  if (post.status !== PUBLISHABLE_STATUS) return `status="${post.status ?? "(none)"}" — only "${PUBLISHABLE_STATUS}" publishes`;
  return "publishable";
}
