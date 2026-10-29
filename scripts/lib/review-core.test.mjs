import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatCallback, parseCallback, posterKeyboard, bulkKeyboard, redoPrompt, extractSlugFromPrompt,
  computeAutoApproveAt, stampReview, isDecided, isUndecided, decidePost, decidedCaption, postLabel,
  remainingLabel, buildDigest, digestDue, planSweep, isBroken, isBulkApprovable, bookingReport,
  AUTO_APPROVE_HOURS, AUTO_APPROVE_MS, LAST_CALL_HOURS,
} from "./review-core.mjs";

const HOUR = 3600_000, DAY = 86_400_000;
const SLUG = "2026-06-22-01";

test("callback round-trips", () => {
  assert.equal(formatCallback("keep", SLUG), "keep|2026-06-22-01");
  assert.deepEqual(parseCallback("skip|2026-06-22-01"), { verb: "skip", slug: SLUG });
  assert.equal(parseCallback("garbage"), null);
  assert.equal(parseCallback("nope|x"), null);
});

test("poster keyboard has three decide buttons", () => {
  const kb = posterKeyboard(SLUG);
  const row = kb.inline_keyboard[0];
  assert.equal(row.length, 3);
  assert.deepEqual(row.map(b => b.callback_data),
    ["keep|2026-06-22-01", "skip|2026-06-22-01", "regen|2026-06-22-01"]);
});

test("bulk keyboard offers approve-all", () => {
  const row = bulkKeyboard().inline_keyboard[0];
  assert.equal(row.length, 1);
  assert.equal(row[0].callback_data, "keepall");
});

test("redo prompt embeds a recoverable slug", () => {
  const txt = redoPrompt(SLUG, "中港結婚");
  assert.equal(extractSlugFromPrompt(txt), SLUG);
  assert.equal(extractSlugFromPrompt("no slug here"), null);
});

test("auto-approve deadline is +48h", () => {
  assert.equal(computeAutoApproveAt(1000), 1000 + AUTO_APPROVE_HOURS * HOUR);
});

test("stampReview sets a fresh, undecided review", () => {
  const post = { slug: SLUG, status: "pending" };
  stampReview(post, 1000);
  assert.equal(post.review.sentAt, 1000);
  assert.equal(post.review.autoApproveAt, 1000 + AUTO_APPROVE_HOURS * HOUR);
  assert.equal(post.review.decidedBy, null);
  assert.equal(post.review.lastCallSent, false);
  assert.equal(post.review.observedLiveMs, 0);
  assert.equal(post.review.lastObservedPollAt, null);
  assert.ok(isUndecided(post));
});

test("decidePost flips status, stamps who decided, returns a label", () => {
  const a = { slug: SLUG, status: "pending", review: {} };
  assert.equal(decidePost(a, "approved", 5, "manual"), "✅ 已標記出");
  assert.ok(isDecided(a));
  assert.equal(a.review.decidedBy, "manual");
  const b = { slug: SLUG, status: "pending", review: {} };
  assert.equal(decidePost(b, "approved", 5, "auto"), "✅ 自動出");
  const c = { slug: SLUG, status: "pending", review: {} };
  assert.equal(decidePost(c, "skip", 5, "manual"), "❌ 已 skip");
});

test("decidedCaption reflects the resolved state", () => {
  const p = { headline: "中港結婚", status: "approved", review: { decidedBy: "auto" } };
  assert.match(decidedCaption(p), /中港結婚/);
  assert.match(decidedCaption(p), /自動出/);
});

test("remainingLabel buckets days/hours/minutes", () => {
  const now = 1_000_000_000_000;
  assert.match(remainingLabel(now + DAY + 4 * HOUR, now), /1 日 4 鐘/);
  assert.match(remainingLabel(now + 2 * HOUR, now), /~2 鐘/);
  assert.match(remainingLabel(now + 10 * 60_000, now), /~10 分鐘/);
});

test("digestDue gates on the 10:00-HK boundary", () => {
  const tenHk = Date.UTC(2026, 5, 18, 2, 0, 0);       // 10:00 HK on 2026-06-18
  assert.equal(digestDue(null, tenHk - 60_000), false);
  assert.equal(digestDue(null, tenHk + 60_000), true);
  assert.equal(digestDue(tenHk + 1, tenHk + 60_000), false);
  assert.equal(digestDue(tenHk - DAY, tenHk + 60_000), true);
});

test("planSweep auto-approves past-deadline undecided posts only", () => {
  const now = 1_000_000_000_000;
  const week = { lastDigestAt: now, posts: [
    { slug: "a", headline: "A", status: "pending",  review: {
      sentAt: now - 3 * DAY, autoApproveAt: now - DAY, decidedBy: null, lastCallSent: false,
      observedLiveMs: AUTO_APPROVE_MS - 60_000, lastObservedPollAt: now - 60_000, livenessUnknown: false,
    } },
    { slug: "b", headline: "B", status: "approved", review: { sentAt: now - 3 * DAY, autoApproveAt: now - DAY, decidedBy: "manual" } },
  ] };
  const r = planSweep(week, now, { liveness: { observedAtMs: now, maxGapMs: 6 * 60_000 }, autoApprove: true });
  assert.equal(r.autoApproved.length, 1);
  assert.equal(r.autoApproved[0].slug, "a");
  assert.equal(week.posts[0].status, "approved");
  assert.equal(week.posts[0].review.decidedBy, "auto");
  assert.equal(week.posts[1].review.decidedBy, "manual");
});

test("expired wall clock without proven bot liveness never auto-approves", () => {
  const now = 1_000_000_000_000;
  const week = { lastDigestAt: now, posts: [{
    slug: "unsafe",
    headline: "Unsafe",
    status: "pending",
    review: {
      sentAt: now - 3 * DAY,
      autoApproveAt: now - DAY,
      decidedBy: null,
      lastCallSent: false,
      observedLiveMs: 0,
      lastObservedPollAt: null,
      livenessUnknown: false,
    },
  }] };
  const result = planSweep(week, now, {
    liveness: { observedAtMs: now, maxGapMs: 6 * 60_000 },
    autoApprove: true,
  });
  assert.equal(week.posts[0].status, "pending");
  assert.deepEqual(result.autoApproved, []);
  assert.deepEqual(result.livenessBlocked.map((post) => post.slug), ["unsafe"]);
  assert.equal(week.posts[0].review.observedLiveMs, 0, "a three-day outage gap earns no live time");
  assert.equal(week.posts[0].review.livenessUnknown, true);
});

test("only accumulated intervals bounded by successful polls can complete the 48h window", () => {
  const now = 1_000_000_000_000;
  const week = { lastDigestAt: now, posts: [{
    slug: "safe",
    status: "pending",
    review: {
      sentAt: now - 3 * DAY,
      autoApproveAt: now - DAY,
      decidedBy: null,
      lastCallSent: false,
      observedLiveMs: AUTO_APPROVE_MS - 60_000,
      lastObservedPollAt: now - 60_000,
      livenessUnknown: true,
    },
  }] };
  const result = planSweep(week, now, {
    liveness: { observedAtMs: now, maxGapMs: 6 * 60_000 },
    autoApprove: true,
  });
  assert.deepEqual(result.autoApproved.map((post) => post.slug), ["safe"]);
  assert.equal(week.posts[0].status, "approved");
});

test("planSweep raises a last-call once inside the 3h window", () => {
  const now = 1_000_000_000_000;
  const week = { lastDigestAt: now, posts: [
    { slug: "a", headline: "A", status: "pending", review: {
      sentAt: now - (AUTO_APPROVE_MS - LAST_CALL_HOURS * HOUR + 60_000),
      autoApproveAt: now + LAST_CALL_HOURS * HOUR - 60_000,
      decidedBy: null,
      lastCallSent: false,
      observedLiveMs: AUTO_APPROVE_MS - LAST_CALL_HOURS * HOUR + 60_000,
      lastObservedPollAt: now,
      livenessUnknown: false,
    } },
  ] };
  const liveness = { observedAtMs: now, maxGapMs: 6 * 60_000 };
  const r1 = planSweep(week, now, { liveness, autoApprove: true });
  assert.equal(r1.lastCalls.length, 1);
  assert.equal(week.posts[0].review.lastCallSent, true);
  const r2 = planSweep(week, now, { liveness, autoApprove: true });
  assert.equal(r2.lastCalls.length, 0);
});

test("planSweep builds a digest listing only undecided posts", () => {
  const tenHk = Date.UTC(2026, 5, 18, 2, 30, 0);
  const week = { lastDigestAt: null, posts: [
    { slug: "a", headline: "中港結婚", status: "pending",  review: { sentAt: tenHk, autoApproveAt: tenHk + DAY, decidedBy: null, lastCallSent: false } },
    { slug: "b", headline: "已決定",   status: "skip",     review: { sentAt: tenHk, autoApproveAt: tenHk + DAY, decidedBy: "manual" } },
  ] };
  const r = planSweep(week, tenHk + 60_000);
  assert.ok(r.digest);
  assert.match(r.digest, /中港結婚/);
  assert.doesNotMatch(r.digest, /已決定/);
  assert.equal(week.lastDigestAt, tenHk + 60_000);
});

// --- cross-brand cases ---
test("SLUG_RE matches both date and ISO-week slugs", () => {
  assert.deepEqual(parseCallback("keep|2026-06-15-01"), { verb: "keep", slug: "2026-06-15-01" });
  assert.deepEqual(parseCallback("skip|2026-W25-03"), { verb: "skip", slug: "2026-W25-03" });
  assert.equal(extractSlugFromPrompt("redo #2026-W25-03 now"), "2026-W25-03");
});

test("postLabel falls back across brand fields", () => {
  assert.equal(postLabel({ title: "T" }), "T");
  assert.equal(postLabel({ name: "梁女士" }), "梁女士");
  assert.equal(postLabel({ slug: "x" }), "x");
});

test("posterKeyboard can omit the regen button (TML)", () => {
  assert.equal(posterKeyboard("2026-06-15-01", { regen: false }).inline_keyboard[0].length, 2);
  assert.equal(posterKeyboard("2026-06-15-01").inline_keyboard[0].length, 3);
});

// --- broken-content guard (regression: the 2026-06-22 BL incident) ---
// A week generated during an API outage produced posts with status:"failed"/error and no
// poster/caption. The 48h auto-approve flipped them to "approved" and the scheduler then
// crashed on undefined captions. Auto-approve must NEVER greenlight broken posts.
test("isBroken flags failed or errored posts", () => {
  assert.equal(isBroken({ status: "failed" }), true);
  assert.equal(isBroken({ status: "pending", error: "gen-poster failed" }), true);
  assert.equal(isBroken({ status: "pending" }), false);
  assert.equal(isBroken({ status: "approved" }), false);
});

test("planSweep never auto-approves broken posts; surfaces them instead", () => {
  const now = 1_000_000_000_000;
  const past = {
    sentAt: now - 3 * DAY,
    autoApproveAt: now - DAY,
    decidedBy: null,
    lastCallSent: false,
    observedLiveMs: AUTO_APPROVE_MS - 60_000,
    lastObservedPollAt: now - 60_000,
    livenessUnknown: false,
  };
  const week = { lastDigestAt: now, posts: [
    { slug: "ok",  headline: "OK",  status: "pending", review: { ...past } },
    { slug: "bad", headline: "BAD", status: "failed",  error: "gen-poster failed", review: { ...past } },
    { slug: "err", headline: "ERR", status: "pending", error: "boom", review: { ...past } },
  ] };
  const r = planSweep(week, now, { liveness: { observedAtMs: now, maxGapMs: 6 * 60_000 }, autoApprove: true });
  assert.deepEqual(r.autoApproved.map((p) => p.slug), ["ok"]);   // only the clean post
  assert.deepEqual(r.broken.map((p) => p.slug), ["bad", "err"]); // broken surfaced for the caller to alert
  assert.equal(week.posts[1].status, "failed");                  // unchanged — NOT approved
  assert.notEqual(week.posts[2].status, "approved");
});

test("planSweep digest excludes broken posts (they need regen, not a decision)", () => {
  const tenHk = Date.UTC(2026, 5, 18, 2, 30, 0);
  const review = (s) => ({ sentAt: s, autoApproveAt: s + DAY, decidedBy: null, lastCallSent: false });
  const week = { lastDigestAt: null, posts: [
    { slug: "a", headline: "等緊決定", status: "pending", review: review(tenHk) },
    { slug: "b", headline: "壞咗",     status: "failed", error: "x", review: review(tenHk) },
  ] };
  const r = planSweep(week, tenHk + 60_000);
  assert.match(r.digest, /等緊決定/);
  assert.doesNotMatch(r.digest, /壞咗/);
});

// --- MANUAL APPROVAL (owner decision 2026-09-18): the default. Nothing publishes without a ✅. ---
test("MANUAL (default): no timer ever approves, even after 48h of proven bot liveness", () => {
  const now = 1_000_000_000_000;
  const week = { lastDigestAt: now, posts: [{
    slug: "a", headline: "A", status: "pending", date: "2099-01-01",
    review: {
      sentAt: now - 3 * DAY, autoApproveAt: now - DAY, decidedBy: null, lastCallSent: false,
      observedLiveMs: AUTO_APPROVE_MS, lastObservedPollAt: now - 60_000, livenessUnknown: false,
    },
  }] };
  const r = planSweep(week, now, { liveness: { observedAtMs: now, maxGapMs: 6 * 60_000 } });
  assert.equal(week.posts[0].status, "pending");
  assert.deepEqual(r.autoApproved, []);
  assert.deepEqual(r.livenessBlocked, [], "no liveness alarm either: there is no timer to protect");
});

test("MANUAL: one reminder inside 24h of the 10:00 HK publish time, never earlier, never twice", () => {
  const publishAt = Date.parse("2026-10-06T10:00:00+08:00");
  const post = {
    slug: "2026-W41-01", headline: "H", status: "pending", date: "2026-10-06",
    review: { sentAt: publishAt - 10 * DAY, autoApproveAt: 0, decidedBy: null, lastCallSent: false },
  };
  const week = { lastDigestAt: publishAt, posts: [post] };
  assert.equal(planSweep(week, publishAt - 25 * HOUR).lastCalls.length, 0, "outside 24h: not yet");
  assert.equal(planSweep(week, publishAt - 23 * HOUR).lastCalls.length, 1);
  assert.equal(planSweep(week, publishAt - 22 * HOUR).lastCalls.length, 0, "only once");
  assert.equal(post.status, "pending", "a reminder never approves");
});

test("keep-all may approve only posts already SHOWN, undecided, unbroken and not past", () => {
  const shown = { slug: "s", status: "generated", date: "2026-10-06", review: { sentAt: 1 } };
  assert.equal(isBulkApprovable(shown, "2026-10-01"), true);
  assert.equal(isBulkApprovable({ ...shown, review: undefined }, "2026-10-01"), false, "never shown");
  assert.equal(isBulkApprovable({ ...shown, review: { sentAt: null } }, "2026-10-01"), false, "never shown");
  assert.equal(isBulkApprovable({ ...shown, status: "skip" }, "2026-10-01"), false, "already decided");
  assert.equal(isBulkApprovable({ ...shown, error: "x" }, "2026-10-01"), false, "broken");
  assert.equal(isBulkApprovable(shown, "2026-10-07"), false, "date already passed");
});

test("bookingReport turns api-schedule output into totals plus every problem line", () => {
  const out = [
    "Owl Standard API schedule: 3 future post(s)",
    "[2026-10-06 10:00 HK · ts=1] 2026-W41-01 — 【x】",
    "  ✅ scheduled · post id 123_456",
    "  2026-10-07 2026-W41-02 — ⏭️ date already occupied; unattended run refuses.",
    "  ⛔ publish blocked/failed: Meta rejected 2026-W41-03: (#200) permission",
    "Scheduled 1, already booked 0, later 1, dup/date-blocked 1, failed 1.",
  ].join("\n");
  const report = bookingReport(out);
  assert.match(report, /成功 1、早前已預約 0、稍後自動預約 1、重複或當日已有帖文 1、失敗 1/);
  assert.match(report, /date already occupied/);
  assert.match(report, /permission/);
  assert.doesNotMatch(report, /✅ scheduled/);
  assert.match(bookingReport("⛔ Publishing control is not positively enabled"), /未能完成[\s\S]*not positively enabled/);
});
