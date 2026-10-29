import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEAD_DAYS, hkMonthKey, daysUntil, isUndelivered, isDeliverable, planMonthlyDelivery, batchHeader,
} from "./monthly-review.mjs";

// 2026-08-04 10:00 HK
const NOW = Date.parse("2026-08-04T02:00:00.000Z");
const TODAY = "2026-08-04";
const post = (over = {}) => ({ slug: "s", date: "2026-09-07", status: "pending", ...over });

test("the month key turns over on HONG KONG's clock, not UTC's", () => {
  // 2026-08-31 23:30 HK is still August; the same instant in UTC is 15:30 on the 31st.
  assert.equal(hkMonthKey(Date.parse("2026-08-31T15:30:00.000Z")), "2026-08");
  // 2026-09-01 00:30 HK — a new month in HK while UTC still reads 31 August.
  assert.equal(hkMonthKey(Date.parse("2026-08-31T16:30:00.000Z")), "2026-09");
});

test("daysUntil measures against the 10:00 HK publish slot", () => {
  assert.equal(daysUntil("2026-08-10", NOW), 6);
  assert.equal(daysUntil("2026-08-04", NOW), 0);
  assert.equal(daysUntil("2026-08-03", NOW), -1);
  assert.equal(daysUntil("nonsense", NOW), Infinity);
});

test("eligibility: only unseen, undecided, unbroken, future posts", () => {
  assert.equal(isDeliverable(post(), TODAY), true);
  assert.equal(isUndelivered({ review: { sentAt: 123 } }), false);

  // already shown
  assert.equal(isDeliverable(post({ review: { sentAt: 1 } }), TODAY), false);
  // already decided either way
  assert.equal(isDeliverable(post({ status: "approved" }), TODAY), false);
  assert.equal(isDeliverable(post({ status: "skip" }), TODAY), false);
  // BROKEN: withheld and being repaired — asking the owner to approve a garbled poster is asking
  // him to do the machine's job.
  assert.equal(isDeliverable(post({ status: "failed" }), TODAY), false);
  assert.equal(isDeliverable(post({ error: "poster-qa: garbled_text" }), TODAY), false);
  // past-dated / undated
  assert.equal(isDeliverable(post({ date: "2026-08-03" }), TODAY), false);
  assert.equal(isDeliverable(post({ date: null }), TODAY), false);
  assert.equal(isDeliverable(null, TODAY), false);
});

test("MONTHLY BATCH: a new calendar month delivers everything unseen", () => {
  const posts = [post({ slug: "a", date: "2026-08-10" }), post({ slug: "b", date: "2026-09-21" })];
  const plan = planMonthlyDelivery({ posts, nowMs: NOW, todayStr: TODAY, lastDeliveredMonth: "2026-07" });
  assert.equal(plan.monthlyBatch, true);
  assert.equal(plan.month, "2026-08");
  assert.deepEqual(plan.deliver.map((p) => p.slug), ["a", "b"]);
});

test("never delivered before: the first run IS a monthly batch, not a silent skip", () => {
  const plan = planMonthlyDelivery({ posts: [post()], nowMs: NOW, todayStr: TODAY, lastDeliveredMonth: null });
  assert.equal(plan.monthlyBatch, true);
  assert.match(plan.reason, /never/);
});

test("SELF-HEALING: a bot down on the 1st still delivers when it comes back", () => {
  // It is the 4th and August was never delivered. The trigger is "the month changed", not "today is
  // the 1st", so a missed 1st is caught up rather than skipped in silence.
  const plan = planMonthlyDelivery({ posts: [post()], nowMs: NOW, todayStr: TODAY, lastDeliveredMonth: "2026-07" });
  assert.equal(plan.monthlyBatch, true);
});

test("within the same month it goes QUIET — that is the whole point", () => {
  const posts = [post({ slug: "far", date: "2026-09-21" })];
  const plan = planMonthlyDelivery({ posts, nowMs: NOW, todayStr: TODAY, lastDeliveredMonth: "2026-08" });
  assert.equal(plan.monthlyBatch, false);
  assert.deepEqual(plan.deliver, []);
  assert.equal(plan.reason, "nothing due");
});

test("SAFETY NET: an unseen post about to publish is delivered OUT of cycle", () => {
  // Generated late, publishes in 6 days, never shown. Monthly cadence must not let it go out unseen.
  const soon = post({ slug: "soon", date: "2026-08-10" });
  const far = post({ slug: "far", date: "2026-09-21" });
  const plan = planMonthlyDelivery({ posts: [soon, far], nowMs: NOW, todayStr: TODAY, lastDeliveredMonth: "2026-08" });
  assert.equal(plan.monthlyBatch, false);
  assert.deepEqual(plan.deliver.map((p) => p.slug), ["soon"], "only the urgent one — the rest waits for the batch");
  assert.match(plan.reason, /never shown/);
});

test("NEGATIVE: the safety net does not fire one day early, and does fire on the boundary", () => {
  const onBoundary = post({ slug: "edge", date: "2026-08-11" });      // exactly LEAD_DAYS away
  const justOutside = post({ slug: "out", date: "2026-08-12" });
  const plan = planMonthlyDelivery({
    posts: [onBoundary, justOutside], nowMs: NOW, todayStr: TODAY, lastDeliveredMonth: "2026-08",
  });
  assert.equal(daysUntil("2026-08-11", NOW), LEAD_DAYS);
  assert.deepEqual(plan.deliver.map((p) => p.slug), ["edge"]);
});

test("NEGATIVE: the safety net never resurrects a broken or already-seen post", () => {
  const posts = [
    post({ slug: "broken", date: "2026-08-06", error: "poster-qa: garbled_text" }),
    post({ slug: "seen", date: "2026-08-06", review: { sentAt: 1 } }),
    post({ slug: "skipped", date: "2026-08-06", status: "skip" }),
  ];
  const plan = planMonthlyDelivery({ posts, nowMs: NOW, todayStr: TODAY, lastDeliveredMonth: "2026-08" });
  assert.deepEqual(plan.deliver, []);
});

test("the batch header names the brand, the month and the count", () => {
  const header = batchHeader("Owl Standard", "2026-09", 4);
  assert.match(header, /Owl Standard/);
  assert.match(header, /2026年9月/);
  assert.match(header, /4 篇/);
  // The rule that governs publishing must be restated where the owner is asked to act.
  assert.match(header, /未批准的帖文不會發佈/, "manual approval is the default");
  assert.doesNotMatch(header, /48/, "the manual header must not promise a timer that does not exist");
  assert.match(batchHeader("Owl Standard", "2026-09", 4, { autoApprove: true }), /48 鐘/);
});
