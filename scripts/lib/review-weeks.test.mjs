// Tests for scripts/lib/review-weeks.mjs — which weeks a review bot is allowed to sweep.
//
// The headline case is the 2026-07-31 STRANDED WEEK regression, included here as a reproducing
// test: before the fix, a post left undecided when weekly-run moved the active-week pointer could
// never auto-approve, because no sweep opened its file again. It stayed "pending" forever.
//
// The control case matters as much as the regression: it proves an ACTIVE week still auto-approves
// after 48h of proven bot liveness, so these tests cannot pass by breaking auto-approval outright.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTO_APPROVE_MS } from "./review-core.mjs";
import { isReviewable, reviewableWeekIds, sweepReviewWeeks } from "./review-weeks.mjs";

// The bot long-polls Telegram about once a minute; liveness credit accrues in steps bounded by
// REVIEW_LIVENESS_CREDIT_MAX_GAP_MS (65s + 3s + 5s). Poll under that bound so each step counts.
const POLL_MS = 60_000;
const MAX_GAP_MS = 73_000;
const NOW = Date.parse("2026-07-31T15:00:00Z");
const SENT = Date.parse("2026-07-27T14:41:16Z"); // 4 days before NOW — well past the 48h window

function makeBrandDir() {
  const root = mkdtempSync(join(tmpdir(), "sce-review-weeks-"));
  const weeksDir = join(root, "weeks");
  mkdirSync(weeksDir, { recursive: true });
  return weeksDir;
}

const undecidedPost = (slug, date) => ({
  slug, date, status: "pending", headline: `post ${slug}`,
  review: { sentAt: SENT, autoApproveAt: SENT + AUTO_APPROVE_MS, decidedAt: null, decidedBy: null, lastCallSent: false },
});

const writeWeek = (weeksDir, id, posts) =>
  writeFileSync(join(weeksDir, `${id}.json`), JSON.stringify({ posts }, null, 2), "utf8");
const readWeek = (weeksDir, id) => JSON.parse(readFileSync(join(weeksDir, `${id}.json`), "utf8"));

/** Run a healthy bot for `hours`, sweeping every POLL_MS. */
function runBotFor(weeksDir, activeId, hours, { autoApprove = true } = {}) {
  const steps = Math.ceil((hours * 3600_000) / POLL_MS);
  let autoApproved = 0;
  for (let i = 0; i <= steps; i += 1) {
    const nowMs = NOW + i * POLL_MS;
    const result = sweepReviewWeeks({
      brand: "test-brand",
      nowMs,
      liveness: { observedAtMs: nowMs, maxGapMs: MAX_GAP_MS },
      weeksDir,
      resolveActiveId: () => activeId,
      autoApprove, // these cases pin the opt-in timed mode; the manual default is tested below
    });
    autoApproved += result.autoApproved.length;
  }
  return autoApproved;
}

test("control: the ACTIVE week auto-approves after 48h of proven bot liveness", () => {
  const weeksDir = makeBrandDir();
  writeWeek(weeksDir, "2026-08-10", [undecidedPost("2026-08-10-01", "2026-08-10")]);

  assert.equal(runBotFor(weeksDir, "2026-08-10", 49), 1);
  const post = readWeek(weeksDir, "2026-08-10").posts[0];
  assert.equal(post.status, "approved");
  assert.equal(post.review.decidedBy, "auto");
});

test("REGRESSION 2026-07-31: a week the pointer has moved past still auto-approves", () => {
  const weeksDir = makeBrandDir();
  writeWeek(weeksDir, "2026-08-10", [undecidedPost("2026-08-10-01", "2026-08-10")]); // stranded
  writeWeek(weeksDir, "2026-08-17", [undecidedPost("2026-08-17-01", "2026-08-17")]); // active

  // weekly-run moved the pointer to the newer week; the older one is no longer "active".
  runBotFor(weeksDir, "2026-08-17", 49);

  assert.equal(
    readWeek(weeksDir, "2026-08-10").posts[0].status, "approved",
    "the stranded week must still be swept — this is the defect that made every approval manual",
  );
  assert.equal(readWeek(weeksDir, "2026-08-17").posts[0].status, "approved");
});

test("MANUAL (default, REVIEW_AUTO_APPROVE_ENABLED unset): 49h of a healthy bot approves nothing", () => {
  const weeksDir = makeBrandDir();
  writeWeek(weeksDir, "2026-08-10", [undecidedPost("2026-08-10-01", "2026-08-10")]);

  assert.equal(runBotFor(weeksDir, "2026-08-10", 49, { autoApprove: false }), 0);
  assert.equal(readWeek(weeksDir, "2026-08-10").posts[0].status, "pending", "only the owner's ✅ approves");
});

test("the production default is manual: sweepReviewWeeks without the switch never auto-approves", () => {
  const weeksDir = makeBrandDir();
  writeWeek(weeksDir, "2026-08-10", [undecidedPost("2026-08-10-01", "2026-08-10")]);
  const previous = process.env.REVIEW_AUTO_APPROVE_ENABLED;
  delete process.env.REVIEW_AUTO_APPROVE_ENABLED;
  try {
    const nowMs = NOW + 49 * 3600_000;
    const result = sweepReviewWeeks({
      brand: "test-brand", nowMs, liveness: { observedAtMs: nowMs, maxGapMs: MAX_GAP_MS },
      weeksDir, resolveActiveId: () => "2026-08-10",
    });
    assert.deepEqual(result.autoApproved, []);
  } finally {
    if (previous !== undefined) process.env.REVIEW_AUTO_APPROVE_ENABLED = previous;
  }
  assert.equal(readWeek(weeksDir, "2026-08-10").posts[0].status, "pending");
});

test("a post whose date has passed is never swept back to life", () => {
  const weeksDir = makeBrandDir();
  writeWeek(weeksDir, "2026-07-20", [undecidedPost("2026-07-20-01", "2026-07-20")]); // already past
  writeWeek(weeksDir, "2026-08-17", [undecidedPost("2026-08-17-01", "2026-08-17")]);

  runBotFor(weeksDir, "2026-08-17", 49);

  assert.equal(
    readWeek(weeksDir, "2026-07-20").posts[0].status, "pending",
    "reaching into older weeks must not resurrect a post that missed its slot",
  );
});

test("decided posts are left alone", () => {
  const weeksDir = makeBrandDir();
  const skipped = { ...undecidedPost("2026-08-10-01", "2026-08-10"), status: "skip" };
  writeWeek(weeksDir, "2026-08-10", [skipped]);

  runBotFor(weeksDir, "2026-08-10", 49);

  assert.equal(readWeek(weeksDir, "2026-08-10").posts[0].status, "skip", "an owner's ❌ must survive");
});

test("a broken post is never auto-approved", () => {
  const weeksDir = makeBrandDir();
  const broken = { ...undecidedPost("2026-08-10-01", "2026-08-10"), error: "image generation failed" };
  writeWeek(weeksDir, "2026-08-10", [broken]);

  runBotFor(weeksDir, "2026-08-10", 49);

  assert.notEqual(readWeek(weeksDir, "2026-08-10").posts[0].status, "approved");
});

test("reviewableWeekIds picks up undecided future weeks and always includes the active week", () => {
  const weeksDir = makeBrandDir();
  writeWeek(weeksDir, "2026-07-20", [undecidedPost("2026-07-20-01", "2026-07-20")]);  // past — excluded
  writeWeek(weeksDir, "2026-08-10", [undecidedPost("2026-08-10-01", "2026-08-10")]);  // stranded — included
  writeWeek(weeksDir, "2026-08-17", [{ ...undecidedPost("2026-08-17-01", "2026-08-17"), status: "approved" }]);

  const ids = reviewableWeekIds("test-brand", NOW, { weeksDir, activeId: "2026-08-17" });
  assert.deepEqual(ids, ["2026-08-10", "2026-08-17"]);
});

test("a malformed week file is skipped, not fatal", () => {
  const weeksDir = makeBrandDir();
  writeFileSync(join(weeksDir, "2026-08-03.json"), "{ this is not json", "utf8");
  writeWeek(weeksDir, "2026-08-10", [undecidedPost("2026-08-10-01", "2026-08-10")]);

  assert.deepEqual(
    reviewableWeekIds("test-brand", NOW, { weeksDir, activeId: "2026-08-10" }),
    ["2026-08-10"],
  );
});

test("isReviewable requires a sent review, an undecided status, and a future date", () => {
  const post = undecidedPost("2026-08-10-01", "2026-08-10");
  assert.equal(isReviewable(post, NOW), true);
  assert.equal(isReviewable({ ...post, status: "approved" }, NOW), false);
  assert.equal(isReviewable({ ...post, review: { sentAt: null } }, NOW), false);
  assert.equal(isReviewable({ ...post, date: "2026-07-01" }, NOW), false);
});

test("at most ONE digest per day across all swept weeks", () => {
  const weeksDir = makeBrandDir();
  writeWeek(weeksDir, "2026-08-10", [undecidedPost("2026-08-10-01", "2026-08-10")]);
  writeWeek(weeksDir, "2026-08-17", [undecidedPost("2026-08-17-01", "2026-08-17")]);

  // 11:00 HK — past DIGEST_HOUR (10:00), so a digest is due exactly once for this HK day.
  const at = Date.parse("2026-08-01T03:00:00Z");
  const sweep = (nowMs) => sweepReviewWeeks({
    brand: "test-brand", nowMs, liveness: { observedAtMs: nowMs, maxGapMs: MAX_GAP_MS },
    weeksDir, resolveActiveId: () => "2026-08-17",
  });

  const first = sweep(at);
  const second = sweep(at + POLL_MS);
  assert.ok(first.digest, "a digest should fire once past the digest hour");
  assert.equal(second.digest, null, "a second sweep the same day must not send another digest");
  assert.match(first.digest, /2/, "the single digest covers posts from both weeks");
});
