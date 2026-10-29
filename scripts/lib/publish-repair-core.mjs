// scripts/lib/publish-repair-core.mjs — PURE logic for PUBLISH-LAYER self-repair. No I/O.
//
// THE GAP THIS CLOSES (2026-08-04)
//   This repo already knew how to self-heal — infra-repair-core.mjs was written on 2026-06-28 after a
//   broken scheduled task made the owner come and fix it by hand. Its lesson was recorded exactly:
//
//     "task-health DID keep running and DID catch it; it just wasn't allowed to FIX it, only to alert."
//
//   That permission was granted to INFRASTRUCTURE and never extended to PUBLISHING. So the publish
//   layer kept re-learning the same lesson the hard way: five ledger slots stuck `uncertain` for days
//   (IG exiting 3 every morning), and posts left broken by the 2026-08-02 Anthropic credit outage
//   still broken on 08-04 with the API long since healthy — because the alert's remedy was a command
//   for a human to type. Detection was never the missing piece. Permission to act was.
//
// SAFETY HEART — the two boundaries, and why they are where they are
//
//   1. A blocked slot may be RELEASED only on a POSITIVE verdict of absence from Meta itself. The
//      publish ledger blocks fail-closed for a good reason, stated in publish-ledger.mjs: an
//      uncertain record may mean Meta accepted the publish before the process died. We do not weaken
//      that. We answer it. `undetermined` — Meta unreachable, pagination exhausted, caption too
//      short — keeps the block and escalates, forever if need be. Only `absent` releases.
//      (Owner policy, 2026-08-04: "auto-republish ONLY when Meta positively confirms absence.")
//
//   2. Content repair NEVER touches a poster-QA error. Those belong to poster-qa-sweep's own
//      judge → redraw → judge loop. Regenerating the copy underneath a poster the image check
//      rejected would destroy the evidence and re-enter a loop already bounded elsewhere.
//
//   Both boundaries are enforced by publish-repair-core.test.mjs, in both directions.
//
// Pure → fully unit-testable. The runner (scripts/repair.mjs) does the I/O and nothing else.

// Attempt bookkeeping is IDENTICAL in shape to the infra repairer's, so it is imported rather than
// re-authored: same { [key]: { date, attempts } } state, same per-calendar-day cap semantics.
import { shouldAttemptRepair, recordRepairAttempt } from "./infra-repair-core.mjs";

export { shouldAttemptRepair, recordRepairAttempt };

export const REPAIR_ACTIONS = Object.freeze({
  CONFIRM: "confirm",   // Meta has it → write the truth into the ledger, unblock the slot
  RELEASE: "release",   // Meta positively does not have it → free the slot so the publisher retries
  HOLD: "hold",         // stay blocked
});

// A slot younger than this is not repaired: a publish attempt may still be in flight in another
// process. It matches the reaper's own staleness threshold, so repair only ever considers records
// the ledger already calls stale — one definition of "stale", not two that can disagree.
export const REPAIR_MIN_AGE_MS = 24 * 60 * 60 * 1000;
// Per slot, per day. A repair that did not take is a fact about the world, not a reason to retry
// harder; beyond this the owner is told rather than the loop spun.
export const LEDGER_REPAIR_DAILY_CAP = 3;
export const CONTENT_REPAIR_DAILY_CAP = 2;

export const QA_ERROR_PREFIX = "poster-qa:";

/** The ledger key for a slot — also the attempt-bookkeeping key. */
export function slotKey(record) {
  return `${record?.brand ?? "?"}/${record?.slug ?? "?"}/${record?.channel ?? "?"}`;
}

/**
 * Decide what to do with ONE uncertain ledger record, given Meta's verdict.
 *
 * @param {object} record        the ledger record ({ status, brand, slug, channel, claimed_at, ... })
 * @param {object} verdict       from meta-publication.judgePublication: { state: found|absent|undetermined }
 * @param {number} attemptsToday how many times this slot was already repaired today
 * @returns {{action: string, reason: string, escalate: boolean, remoteId?: string}}
 */
export function planLedgerRepair({
  record,
  verdict,
  ageMs,
  attemptsToday = 0,
  cap = LEDGER_REPAIR_DAILY_CAP,
  minAgeMs = REPAIR_MIN_AGE_MS,
} = {}) {
  const hold = (reason, escalate = false) => ({ action: REPAIR_ACTIONS.HOLD, reason, escalate });

  // Only ever touch a record the ledger itself calls uncertain. A confirmed record is the ledger's
  // memory of a real publish; a repairer that can rewrite it is a repairer that can cause a double post.
  if (!record || record.status !== "uncertain") {
    return hold(`not an uncertain record (status=${record?.status ?? "none"})`);
  }
  if (!Number.isFinite(ageMs) || ageMs < minAgeMs) {
    return hold("record is younger than the repair threshold; a publish may still be in flight");
  }
  if (attemptsToday >= cap) {
    return hold(`repair attempted ${attemptsToday}x today (cap ${cap}) — needs a person`, true);
  }

  switch (verdict?.state) {
    case "found":
      if (!verdict.remoteId) return hold("Meta reported a match without an id — refusing to confirm a slot with no identity", true);
      return {
        action: REPAIR_ACTIONS.CONFIRM,
        reason: `Meta has this post (${verdict.remoteId}) — the publish DID succeed; recording it`,
        escalate: false,
        remoteId: verdict.remoteId,
      };
    case "absent":
      return {
        action: REPAIR_ACTIONS.RELEASE,
        reason: "Meta positively does not have this post in the attempt window — releasing so it can publish",
        escalate: false,
      };
    case "undetermined":
      return hold(`could not determine whether it published: ${verdict.reason || "no reason given"}`, true);
    default:
      return hold(`unrecognised verdict from the publication lookup: ${JSON.stringify(verdict?.state ?? null)}`, true);
  }
}

/** True for a post the engine considers broken — same predicate the review sweep uses. */
export function isRepairableBreak(post) {
  if (!post) return false;
  if (post.status === "failed") return true;
  return Boolean(post.error) && !String(post.error).startsWith(QA_ERROR_PREFIX);
}

/**
 * Decide whether to regenerate ONE broken post.
 *
 * `quiet` matters: when the AI provider is down, preflight.mjs ALREADY owns that alarm and screens
 * it. A second alarm from here would double-ping the owner for one fault — the noise that trains
 * people to ignore alarms, which is the failure mode this whole exercise exists to prevent.
 */
export function planContentRepair({
  post,
  providerHealthy,
  todayStr,
  attemptsToday = 0,
  cap = CONTENT_REPAIR_DAILY_CAP,
} = {}) {
  const skip = (reason, extra = {}) => ({ action: "skip", reason, escalate: false, ...extra });

  if (!post) return skip("no post");
  if (String(post.error || "").startsWith(QA_ERROR_PREFIX)) {
    return skip("poster-qa owns this error — its own redraw loop repairs it, not this one");
  }
  if (!isRepairableBreak(post)) return skip("post is not broken");
  if (post.fbPostId || post.igPostId) {
    return skip("post is already published somewhere — regenerating it would rewrite live content", { escalate: true });
  }
  if (!post.date || !todayStr || post.date < todayStr) {
    return skip("post date has passed — regenerating it would publish stale content");
  }
  if (!providerHealthy) {
    return skip("AI provider is not healthy — preflight already owns that alarm", { quiet: true });
  }
  if (attemptsToday >= cap) {
    return { action: "skip", reason: `regenerated ${attemptsToday}x today (cap ${cap}) and still broken — needs a person`, escalate: true };
  }
  return { action: "regenerate", reason: "provider is healthy and the post is still ahead — regenerating", escalate: false };
}

/**
 * Round-robin start offset, so a time-boxed sweep that never finishes cannot starve the same tail
 * every run. SCE-PosterQA processed brands in a fixed order and was SIGTERMed at its 20-minute
 * ceiling on 2026-07-31 and 2026-08-03 — which means the LAST brand in that fixed order was never
 * inspected at all, silently, while the job looked merely "slow".
 */
export function rotateForFairness(items, cursor = 0) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const start = ((Number(cursor) || 0) % list.length + list.length) % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

/** Where the next run should start, given where this one got to. */
export function advanceCursor(cursor, processed, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return (((Number(cursor) || 0) + (Number(processed) || 0)) % total + total) % total;
}
