// scripts/lib/review-weeks.mjs — WHICH weeks a review bot sweeps, and the one sweep across all of them.
//
// WHY THIS FILE EXISTS (2026-07-31 incident)
// Every review bot used to sweep exactly ONE week: the file active-week.json points at.
// But scripts/<brand>/weekly-run.mjs calls setActiveWeek() every Thursday when it generates the
// next week — so the pointer MOVES FORWARD every week. Any post still undecided at that moment
// became unreachable: no sweep ever opened its file again, so its 48-hour auto-approval could
// never fire. It sat at status="pending" forever and was never published.
//
// Measured on the live pages that day: every single approved post carried review.decidedBy="manual".
// Timed auto-approval — the whole mechanism that makes this system unattended — had NEVER fired in
// production. Three of the four brands had no post booked for 2026-08-10 because those posts were
// stranded in a week the bots had stopped looking at, two days past their auto-approve deadline.
//
// THE RULE: a review bot sweeps EVERY week that still holds an undecided post whose date has not
// passed. The active-week pointer decides where new posters are filed and where the daily digest
// bookkeeping lives — it must never again decide what is allowed to be reviewed.
//
// Pinned by scripts/lib/review-weeks.test.mjs, which includes the stranded-week regression as a
// reproducing case (a control proves an ACTIVE week still auto-approves, so the test cannot pass
// by simply breaking auto-approval everywhere).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { companyStatePath } from "./paths.mjs";
import { activeWeekPath } from "./artifacts.mjs";
import { buildDigest, digestDue, isBroken, isDecided, planSweep } from "./review-core.mjs";
import { hkTodayStr, postDate } from "./watchdog-core.mjs";
import { planMonthlyDelivery } from "./monthly-review.mjs";
import { readEnabledFlag } from "./env.mjs";

// OFF unless exactly "true": every post needs the owner's explicit ✅ before it can publish.
// Owner decision 2026-09-18 — timed auto-approval stays in the code only behind this switch.
export const AUTO_APPROVE_ENV = "REVIEW_AUTO_APPROVE_ENABLED";
export const autoApproveEnabled = () => readEnabledFlag(AUTO_APPROVE_ENV);

/** A post the bot may still act on: sent for review, not yet decided, and not in the past. */
export function isReviewable(post, nowMs) {
  if (!post || post.review?.sentAt == null) return false;
  if (isDecided(post)) return false;
  return postDate(post, nowMs) >= hkTodayStr(nowMs);
}

/**
 * Every week id worth sweeping, oldest first. A week qualifies when it holds at least one
 * reviewable post. The active week is always included even when fully decided, because it is
 * where the once-a-day digest timestamp is kept.
 */
export function reviewableWeekIds(brand, nowMs, {
  weeksDir = companyStatePath(brand, "weeks"),
  readDir = readdirSync,
  read = readFileSync,
  exists = existsSync,
  activeId = null,
} = {}) {
  if (!exists(weeksDir)) return activeId ? [activeId] : [];
  const ids = [];
  for (const file of readDir(weeksDir).filter((f) => f.endsWith(".json")).sort()) {
    const id = basename(file, ".json");
    if (id === activeId) { ids.push(id); continue; }
    let week;
    try { week = JSON.parse(read(join(weeksDir, file), "utf8")); }
    catch { continue; } // a malformed week file must not take the bot down
    if ((week.posts || []).some((post) => isReviewable(post, nowMs))) ids.push(id);
  }
  if (activeId && !ids.includes(activeId)) ids.push(activeId);
  return ids.sort();
}

/** Resolve the active week id, or null when no pointer exists yet. */
export function activeWeekId(brand) {
  try { return basename(activeWeekPath(brand), ".json"); } catch { return null; }
}

/**
 * Every reviewable week as `{ id, week }`, oldest first — for the bot's `list` and `keep all`.
 *
 * Both commands used to read ONLY active-week.json. That was merely narrow while the queue was one
 * week deep; once catchup started keeping ~8 weeks ready (2026-07-31) the pointer sits on the
 * FURTHEST week, so `list` would show a week two months out and — far worse — `keep all` would
 * approve that far week while the posts going out next Monday stayed undecided. A command whose
 * name says "all" must not silently mean "one arbitrary week".
 */
export function loadReviewableWeeks({
  brand,
  nowMs,
  weeksDir = companyStatePath(brand, "weeks"),
  loadWeek = (id) => JSON.parse(readFileSync(join(weeksDir, `${id}.json`), "utf8")),
  resolveActiveId = () => activeWeekId(brand),
} = {}) {
  const out = [];
  for (const id of reviewableWeekIds(brand, nowMs, { weeksDir, activeId: resolveActiveId() })) {
    try { out.push({ id, week: loadWeek(id) }); } catch { /* malformed week: skip, never crash the bot */ }
  }
  return out;
}

/**
 * Sweep EVERY reviewable week for one brand and return the aggregated outcome.
 *
 * Shape matches planSweep's so callers notify identically:
 *   { autoApproved, lastCalls, digest, broken, livenessBlocked }
 *
 * Two invariants this function owns and planSweep does not:
 *  1. POSTS WHOSE DATE HAS PASSED ARE NEVER SWEPT. Reaching back into older week files must not
 *     resurrect a post that missed its slot and publish it late; only future-dated work is eligible.
 *  2. AT MOST ONE DIGEST PER DAY across all weeks. planSweep keeps its digest timestamp per week,
 *     so sweeping N weeks would otherwise send N digests. The per-week digest is suppressed and one
 *     combined digest is built here, with the timestamp kept on the active week.
 */
export function sweepReviewWeeks({
  brand,
  nowMs,
  liveness,
  weeksDir = companyStatePath(brand, "weeks"),
  loadWeek = (id) => JSON.parse(readFileSync(join(weeksDir, `${id}.json`), "utf8")),
  saveWeek = (id, week) => writeFileSync(join(weeksDir, `${id}.json`), JSON.stringify(week, null, 2), "utf8"),
  resolveActiveId = () => activeWeekId(brand),
  listIds = (activeId) => reviewableWeekIds(brand, nowMs, { weeksDir, activeId }),
  autoApprove = autoApproveEnabled(),
} = {}) {
  const activeId = resolveActiveId();
  const ids = listIds(activeId);
  const out = { autoApproved: [], lastCalls: [], digest: null, broken: [], livenessBlocked: [] };
  const undecided = [];
  let activeWeek = null;

  for (const id of ids) {
    let week;
    try { week = loadWeek(id); } catch { continue; }
    if (id === activeId) activeWeek = week;

    const eligible = (week.posts || []).filter((post) => postDate(post, nowMs) >= hkTodayStr(nowMs));
    if (!eligible.length) continue;

    const before = JSON.stringify(week);
    // planSweep mutates the post objects themselves, which `eligible` shares with `week`, so the
    // filtered view is enough to keep past-dated posts untouched while still persisting decisions.
    // lastDigestAt is pinned to nowMs purely to suppress planSweep's own per-week digest.
    const view = { posts: eligible, lastDigestAt: nowMs };
    const result = planSweep(view, nowMs, { liveness, autoApprove });

    out.autoApproved.push(...result.autoApproved);
    out.lastCalls.push(...result.lastCalls);
    out.broken.push(...result.broken);
    out.livenessBlocked.push(...result.livenessBlocked);
    undecided.push(...eligible.filter((post) => !isDecided(post) && !isBroken(post) && post.review?.sentAt != null));

    if (JSON.stringify(week) !== before) saveWeek(id, week);
  }

  if (undecided.length && activeWeek && digestDue(activeWeek.lastDigestAt ?? null, nowMs)) {
    out.digest = buildDigest(undecided, nowMs, { autoApprove });
    activeWeek.lastDigestAt = nowMs;
    saveWeek(activeId, activeWeek);
  }

  return out;
}

/**
 * WHAT TO SHOW THE OWNER, and when (2026-08-04).
 *
 * This deliberately does NOT reuse reviewableWeekIds above: that helper requires
 * `review.sentAt != null`, i.e. it only sees posts ALREADY shown. Delivery is the opposite
 * question — which posts have never been shown — so it must read every week file on disk. Reusing
 * the reviewable list would have found nothing, silently, forever.
 *
 * Returns the posts to deliver plus a `save()` the caller invokes AFTER stamping them, so a post is
 * only ever marked "shown" once Telegram has actually accepted it.
 */
export function sweepPendingDeliveries({
  brand,
  nowMs,
  lastDeliveredMonth,
  weeksDir = companyStatePath(brand, "weeks"),
  listFiles = () => (existsSync(weeksDir)
    ? readdirSync(weeksDir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()
    : []),
  readWeek = (file) => JSON.parse(readFileSync(join(weeksDir, file), "utf8")),
  writeWeek = (file, week) => writeFileSync(join(weeksDir, file), JSON.stringify(week, null, 2), "utf8"),
} = {}) {
  const loaded = [];
  const posts = [];
  for (const file of listFiles()) {
    let week;
    try { week = readWeek(file); } catch { continue; }
    loaded.push({ file, week });
    for (const post of week.posts || []) posts.push(post);
  }

  const plan = planMonthlyDelivery({ posts, nowMs, todayStr: hkTodayStr(nowMs), lastDeliveredMonth });
  return {
    ...plan,
    save() {
      for (const { file, week } of loaded) {
        try { writeWeek(file, week); } catch {}
      }
    },
  };
}
