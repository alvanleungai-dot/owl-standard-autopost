import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPAIR_ACTIONS, REPAIR_MIN_AGE_MS, LEDGER_REPAIR_DAILY_CAP, CONTENT_REPAIR_DAILY_CAP,
  planLedgerRepair, planContentRepair, isRepairableBreak, slotKey,
  rotateForFairness, advanceCursor,
  shouldAttemptRepair, recordRepairAttempt,
} from "./publish-repair-core.mjs";

const OLD = REPAIR_MIN_AGE_MS + 1;
const uncertain = (over = {}) => ({
  brand: "better-life", slug: "2026-W32-01", channel: "ig",
  status: "uncertain", planned_date: "2026-08-04", claimed_at: "2026-08-01T02:05:00.000Z", ...over,
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// BOUNDARY 1 — only a POSITIVE verdict of absence may release a blocked slot.
// These are the tests that stand between an ambiguous read and a duplicate post on a client's
// live Instagram account. Every non-"absent" verdict must HOLD.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("RELEASE happens only on a positive 'absent' verdict", () => {
  const plan = planLedgerRepair({ record: uncertain(), verdict: { state: "absent" }, ageMs: OLD });
  assert.equal(plan.action, REPAIR_ACTIONS.RELEASE);
  assert.equal(plan.escalate, false);
});

test("NEGATIVE: every undetermined verdict HOLDS and escalates — it never releases", () => {
  const reasons = [
    "pagination bound reached before the window start; 500 item(s) seen",
    "Meta instagram media read failed: fetch failed",
    "caption too short to identify a post on the account",
    "LOOKUP BUG (TypeError): x is not a function — a fault in the verifier, not in the account",
  ];
  for (const reason of reasons) {
    const plan = planLedgerRepair({ record: uncertain(), verdict: { state: "undetermined", reason }, ageMs: OLD });
    assert.equal(plan.action, REPAIR_ACTIONS.HOLD, `must hold for: ${reason}`);
    assert.equal(plan.escalate, true, `must escalate for: ${reason}`);
    assert.match(plan.reason, /could not determine/);
  }
});

test("NEGATIVE: an unrecognised or missing verdict state HOLDS rather than defaulting to release", () => {
  for (const verdict of [undefined, {}, { state: null }, { state: "maybe" }, { state: "ABSENT" }]) {
    const plan = planLedgerRepair({ record: uncertain(), verdict, ageMs: OLD });
    assert.equal(plan.action, REPAIR_ACTIONS.HOLD, `must hold for: ${JSON.stringify(verdict)}`);
    assert.equal(plan.escalate, true);
  }
});

test("CONFIRM records Meta's own id — and refuses to confirm a match with no id", () => {
  const ok = planLedgerRepair({ record: uncertain(), verdict: { state: "found", remoteId: "17900000000000000" }, ageMs: OLD });
  assert.equal(ok.action, REPAIR_ACTIONS.CONFIRM);
  assert.equal(ok.remoteId, "17900000000000000");

  // A "found" with no identity cannot be written into the ledger: the ledger's whole job is to hold
  // the remote identity of a publish.
  const bad = planLedgerRepair({ record: uncertain(), verdict: { state: "found" }, ageMs: OLD });
  assert.equal(bad.action, REPAIR_ACTIONS.HOLD);
  assert.equal(bad.escalate, true);
});

test("NEGATIVE: a CONFIRMED ledger record is never touched, whatever Meta says", () => {
  for (const state of ["found", "absent", "undetermined"]) {
    const plan = planLedgerRepair({
      record: uncertain({ status: "confirmed" }), verdict: { state, remoteId: "1" }, ageMs: OLD,
    });
    assert.equal(plan.action, REPAIR_ACTIONS.HOLD, `confirmed record must be untouched for verdict ${state}`);
    assert.match(plan.reason, /not an uncertain record/);
  }
});

test("NEGATIVE: a record younger than the threshold is never repaired — a publish may be in flight", () => {
  const plan = planLedgerRepair({ record: uncertain(), verdict: { state: "absent" }, ageMs: REPAIR_MIN_AGE_MS - 1 });
  assert.equal(plan.action, REPAIR_ACTIONS.HOLD);
  assert.match(plan.reason, /in flight/);
  // ...and a non-finite age (unparseable timestamps) is treated as "too young", not as "old enough".
  assert.equal(planLedgerRepair({ record: uncertain(), verdict: { state: "absent" }, ageMs: NaN }).action, REPAIR_ACTIONS.HOLD);
});

test("NEGATIVE: past the daily cap it stops trying and asks for a person, even on a clean verdict", () => {
  const plan = planLedgerRepair({
    record: uncertain(), verdict: { state: "absent" }, ageMs: OLD, attemptsToday: LEDGER_REPAIR_DAILY_CAP,
  });
  assert.equal(plan.action, REPAIR_ACTIONS.HOLD);
  assert.equal(plan.escalate, true);
  assert.match(plan.reason, /needs a person/);
});

test("CONTROL: the cap does not fire one attempt early", () => {
  const plan = planLedgerRepair({
    record: uncertain(), verdict: { state: "absent" }, ageMs: OLD, attemptsToday: LEDGER_REPAIR_DAILY_CAP - 1,
  });
  assert.equal(plan.action, REPAIR_ACTIONS.RELEASE);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// BOUNDARY 2 — content repair never reaches into poster-QA's territory, never rewrites published
// content, and never regenerates the past.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const TODAY = "2026-08-04";
const broken = (over = {}) => ({ slug: "2026-W35-01", date: "2026-08-31", status: "failed", ...over });

test("a broken, future-dated post regenerates when the provider is healthy", () => {
  const plan = planContentRepair({ post: broken(), providerHealthy: true, todayStr: TODAY });
  assert.equal(plan.action, "regenerate");
});

test("NEGATIVE: a poster-qa error is NEVER content-repaired — that loop belongs to poster-qa-sweep", () => {
  const plan = planContentRepair({
    post: broken({ status: "pending", error: "poster-qa: mascot has three hands" }),
    providerHealthy: true, todayStr: TODAY,
  });
  assert.equal(plan.action, "skip");
  assert.match(plan.reason, /poster-qa owns this error/);
  // and the shared predicate agrees, so the two cannot drift apart
  assert.equal(isRepairableBreak({ error: "poster-qa: garbled button" }), false);
  assert.equal(isRepairableBreak({ error: "Anthropic 400: credit balance is too low" }), true);
  assert.equal(isRepairableBreak({ status: "failed" }), true);
  assert.equal(isRepairableBreak({ status: "approved" }), false);
});

test("NEGATIVE: an already-published post is never regenerated, and that is loud", () => {
  for (const id of [{ fbPostId: "123_456" }, { igPostId: "1790000" }]) {
    const plan = planContentRepair({ post: broken(id), providerHealthy: true, todayStr: TODAY });
    assert.equal(plan.action, "skip");
    assert.equal(plan.escalate, true, "rewriting live content must not pass silently");
    assert.match(plan.reason, /already published/);
  }
});

test("NEGATIVE: a post whose date has passed is never regenerated", () => {
  const plan = planContentRepair({ post: broken({ date: "2026-08-03" }), providerHealthy: true, todayStr: TODAY });
  assert.equal(plan.action, "skip");
  assert.match(plan.reason, /date has passed/);
});

test("NEGATIVE: an unhealthy provider skips QUIETLY — preflight already owns that alarm", () => {
  const plan = planContentRepair({ post: broken(), providerHealthy: false, todayStr: TODAY });
  assert.equal(plan.action, "skip");
  assert.equal(plan.quiet, true, "a second alarm for one fault is the noise that trains people to ignore alarms");
  assert.equal(plan.escalate, false);
});

test("NEGATIVE: repeated failed regeneration stops and asks for a person", () => {
  const plan = planContentRepair({
    post: broken(), providerHealthy: true, todayStr: TODAY, attemptsToday: CONTENT_REPAIR_DAILY_CAP,
  });
  assert.equal(plan.action, "skip");
  assert.equal(plan.escalate, true);
  assert.match(plan.reason, /needs a person/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// FAIRNESS — the defect that made SCE-PosterQA's timeout silently mean "the last brand is never
// checked", rather than merely "the job is slow".
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("rotateForFairness moves the starting point so a time-boxed sweep cannot starve its tail", () => {
  const brands = ["better-life", "tml", "sunmood", "bright-day"];
  assert.deepEqual(rotateForFairness(brands, 0), brands);
  assert.deepEqual(rotateForFairness(brands, 2), ["sunmood", "bright-day", "better-life", "tml"]);
  // wrap-around and negative/garbage cursors stay in range rather than throwing or emptying the list
  assert.deepEqual(rotateForFairness(brands, 6), ["sunmood", "bright-day", "better-life", "tml"]);
  assert.deepEqual(rotateForFairness(brands, -1), ["bright-day", "better-life", "tml", "sunmood"]);
  assert.deepEqual(rotateForFairness(brands, NaN), brands);
  assert.deepEqual(rotateForFairness([], 3), []);
  assert.deepEqual(rotateForFairness(null, 3), []);
});

test("PROOF OF FAIRNESS: a run that only ever finishes 2 of 4 brands still reaches every brand", () => {
  const brands = ["better-life", "tml", "sunmood", "bright-day"];
  const seen = new Set();
  let cursor = 0;
  for (let run = 0; run < 2; run += 1) {
    const order = rotateForFairness(brands, cursor);
    order.slice(0, 2).forEach((b) => seen.add(b));   // the run dies after two brands, every time
    cursor = advanceCursor(cursor, 2, brands.length);
  }
  assert.deepEqual([...seen].sort(), [...brands].sort(),
    "with a fixed order the last two brands would never be inspected at all");
});

test("PROOF OF FAIRNESS 2: a run that never finishes even ONE brand still rotates", () => {
  // Measured on the first live run: "completed 0/4 · OUT OF TIME before: better-life, tml, sunmood,
  // bright-day" — the whole budget went inside the FIRST brand. Advancing by completed-count alone
  // would pin the cursor at 0 forever, reproducing the starvation the rotation exists to end.
  const brands = ["better-life", "tml", "sunmood", "bright-day"];
  const firstSeen = new Set();
  let cursor = 0;
  for (let run = 0; run < 4; run += 1) {
    const order = rotateForFairness(brands, cursor);
    firstSeen.add(order[0]);
    const brandsCompleted = 0;                       // ran out of time inside brand #1, every time
    cursor = advanceCursor(cursor, Math.max(brandsCompleted, 1), brands.length);
  }
  assert.deepEqual([...firstSeen].sort(), [...brands].sort(),
    "every brand must eventually get to be inspected FIRST, or the tail is never checked at all");
});

test("advanceCursor wraps and survives empty/garbage input", () => {
  assert.equal(advanceCursor(0, 2, 4), 2);
  assert.equal(advanceCursor(3, 3, 4), 2);
  assert.equal(advanceCursor(0, 0, 0), 0);
  assert.equal(advanceCursor(NaN, NaN, 4), 0);
});

test("attempt bookkeeping is the infra repairer's, reused: per-key, per-calendar-day", () => {
  const key = slotKey(uncertain());
  assert.equal(key, "better-life/2026-W32-01/ig");
  let state = {};
  assert.equal(shouldAttemptRepair(state, key, TODAY, 2), true);
  state = recordRepairAttempt(state, key, TODAY);
  state = recordRepairAttempt(state, key, TODAY);
  assert.equal(shouldAttemptRepair(state, key, TODAY, 2), false);
  // a new day resets the budget
  assert.equal(shouldAttemptRepair(state, key, "2026-08-05", 2), true);
  // and one slot's exhaustion never blocks another
  assert.equal(shouldAttemptRepair(state, "tml/2026-08-03-01/ig", TODAY, 2), true);
});
