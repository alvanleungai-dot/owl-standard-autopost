import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deliverDueReviews, shouldAttemptDelivery, MAX_DELIVERY_ATTEMPTS, RETRY_BACKOFF_MS } from "./deliver-monthly.mjs";
import { weeklyDeliveryEnabled, reviewDeliveryMode, deliverReviewPhotos } from "./review-delivery.mjs";

const NOW = Date.parse("2026-08-04T02:00:00.000Z");
const post = (over = {}) => ({ slug: "s1", date: "2026-09-07", status: "pending", ...over });

function harness({ deliver, monthlyBatch = true, notify = async () => true, month = "2026-08", prior } = {}) {
  const state = { written: null, saved: false, replies: [], stateWrites: [], alerts: [] };
  const run = (extra = {}) => deliverDueReviews({
    brand: "better-life",
    brandLabel: "百達利",
    nowMs: NOW,
    notifyPhoto: notify,
    photoPath: (p) => `/posters/${p.slug}.png`,
    caption: (p) => p.slug,
    keyboard: (slug) => ({ slug }),
    reply: async (text) => { state.replies.push(text); },
    sweep: () => ({ deliver, monthlyBatch, month, reason: "test", save: () => { state.saved = true; } }),
    readState: () => prior ?? { lastDeliveredMonth: null, failedMonth: null, attempts: 0 },
    writeState: (_b, s) => { state.stateWrites.push(s); },
    writeMonth: (_b, m) => { state.written = m; },
    alert: async (issue) => { state.alerts.push(issue); return true; },
    log: () => {},
    ...extra,
  });
  return { run, state };
}

test("a monthly batch opens with ONE header, then the posters, oldest first", async () => {
  const later = post({ slug: "later", date: "2026-09-21" });
  const sooner = post({ slug: "sooner", date: "2026-09-07" });
  const sent = [];
  const h = harness({ deliver: [later, sooner], notify: async (p) => { sent.push(p); return true; } });
  const r = await h.run();
  assert.equal(h.state.replies.length, 1, "one header, not one per post");
  assert.match(h.state.replies[0], /百達利/);
  assert.deepEqual(r.sent, ["sooner", "later"], "delivered in publish order");
  assert.deepEqual(sent, ["/posters/sooner.png", "/posters/later.png"]);
  assert.equal(h.state.written, "2026-08", "the month must close so it does not re-send all month");
});

test("the safety-net path sends NO header — it is not a batch", async () => {
  const h = harness({ deliver: [post()], monthlyBatch: false });
  await h.run();
  assert.equal(h.state.replies.length, 0);
  assert.equal(h.state.written, null, "an out-of-cycle send must not close the month");
});

// ── the ordering rule that keeps a post from publishing unseen ────────────────────────────────────

test("a post is stamped ONLY after Telegram accepts it", async () => {
  const good = post({ slug: "ok" });
  const bad = post({ slug: "failed" });
  const h = harness({
    deliver: [good, bad],
    notify: async (path) => !path.includes("failed"),
  });
  const r = await h.run();
  assert.deepEqual(r.sent, ["ok"]);
  assert.deepEqual(r.failed, ["failed"]);
  assert.ok(good.review?.sentAt, "the delivered post starts its review clock");
  assert.equal(bad.review, undefined,
    "an UNDELIVERED post must not be stamped — stamping starts the 48h auto-approve on a poster he never saw");
});

test("a throwing transport is a failure, not a crash", async () => {
  const p = post();
  const h = harness({ deliver: [p], notify: async () => { throw new Error("telegram down"); } });
  const r = await h.run();
  assert.deepEqual(r.failed, ["s1"]);
  assert.equal(p.review, undefined);
});

test("a PARTLY failed batch leaves the month OPEN so the remainder retries", async () => {
  const h = harness({
    deliver: [post({ slug: "a" }), post({ slug: "b" })],
    notify: async (path) => path.includes("a."),
  });
  const r = await h.run();
  assert.equal(r.failed.length, 1);
  assert.equal(h.state.written, null,
    "closing the month here would strand the undelivered post until the NEXT calendar month");
});

test("an EMPTY monthly batch still closes the month", async () => {
  // Otherwise every sweep for the rest of the month re-decides it is batch day, and the header
  // fires the moment a single post appears.
  const h = harness({ deliver: [], monthlyBatch: true });
  const r = await h.run();
  assert.deepEqual(r.sent, []);
  assert.equal(h.state.written, "2026-08");
});

// ── the retry bound (added after the loop it prevents actually happened) ─────────────────────────
// Measured on the first live run: Bright Day's bot returns `chat not found` — the owner never
// pressed START, so it can NEVER message him — and the sweep re-sent the same five posters every
// 60 seconds. A repair loop with no convergence check is the exact failure this session's own retro
// warns about, committed by the code that wrote the warning.

test("a persistent delivery failure STOPS hammering once the budget is spent", async () => {
  const attempted = [];
  const h = harness({
    deliver: [post()],
    prior: { lastDeliveredMonth: null, failedMonth: "2026-08", attempts: MAX_DELIVERY_ATTEMPTS, lastAttemptAt: NOW - 60_000 },
    notify: async (p) => { attempted.push(p); return false; },
  });
  const r = await h.run();
  assert.equal(r.exhausted, true);
  assert.deepEqual(attempted, [], "must not attempt again a minute later");
});

// ── recovery: the bound must limit the RATE, not the possibility ─────────────────────────────────
// The first version stopped permanently for the month. That recreated the very disease this session
// is about: it told the owner what to fix, he fixed it (pressed START on the Bright Day bot minutes
// later), and nothing ever tried again.

test("RECOVERY: after the backoff it tries again by itself — no human step", async () => {
  const attempted = [];
  const h = harness({
    deliver: [post()],
    prior: {
      lastDeliveredMonth: null, failedMonth: "2026-08",
      attempts: MAX_DELIVERY_ATTEMPTS, lastAttemptAt: NOW - RETRY_BACKOFF_MS - 1,
    },
    notify: async (p) => { attempted.push(p); return true; },
  });
  const r = await h.run();
  assert.deepEqual(r.sent, ["s1"], "a channel a human repaired must come back on its own");
  assert.equal(h.state.written, "2026-08");
  assert.equal(attempted.length, 1);
});

test("shouldAttemptDelivery: fast budget, then hourly, forever", () => {
  const base = { month: "2026-08", failedMonth: "2026-08", nowMs: NOW };
  assert.equal(shouldAttemptDelivery({ ...base, attempts: 0 }), true);
  assert.equal(shouldAttemptDelivery({ ...base, attempts: MAX_DELIVERY_ATTEMPTS, lastAttemptAt: NOW - 1000 }), false);
  assert.equal(shouldAttemptDelivery({ ...base, attempts: MAX_DELIVERY_ATTEMPTS, lastAttemptAt: NOW - RETRY_BACKOFF_MS }), true);
  assert.equal(shouldAttemptDelivery({ ...base, attempts: 99, lastAttemptAt: NOW - RETRY_BACKOFF_MS * 5 }), true,
    "it never becomes permanently silent, however many times it has failed");
  // An OLD state file, written before lastAttemptAt existed, must resume rather than stay stuck —
  // this is what unblocks Bright Day on the very deploy that ships the fix.
  assert.equal(shouldAttemptDelivery({ ...base, attempts: MAX_DELIVERY_ATTEMPTS, lastAttemptAt: undefined }), true);
  assert.equal(shouldAttemptDelivery({ ...base, attempts: MAX_DELIVERY_ATTEMPTS, lastAttemptAt: "garbage" }), true);
});

test("it escalates ONCE, not on every hourly retry", async () => {
  const h = harness({
    deliver: [post()],
    prior: {
      lastDeliveredMonth: null, failedMonth: "2026-08",
      attempts: MAX_DELIVERY_ATTEMPTS, lastAttemptAt: NOW - RETRY_BACKOFF_MS - 1,
    },
    notify: async () => false,
  });
  await h.run();
  assert.equal(h.state.alerts.length, 0,
    "the alarm fires when the budget is first spent; hourly retries after that must stay quiet");
});

test("each failed batch spends exactly one attempt, and the month stays open", async () => {
  const h = harness({
    deliver: [post()],
    prior: { lastDeliveredMonth: null, failedMonth: "2026-08", attempts: 1 },
    notify: async () => false,
  });
  const r = await h.run();
  assert.equal(r.attempts, 2);
  assert.deepEqual(h.state.stateWrites.at(-1), { lastDeliveredMonth: null, failedMonth: "2026-08", attempts: 2, lastAttemptAt: NOW });
  assert.equal(h.state.written, null, "the month must stay open while attempts remain");
  assert.equal(h.state.alerts.length, 0, "do not shout before the budget is spent");
});

test("on the LAST attempt it escalates once, through the ops bot that still works", async () => {
  const h = harness({
    deliver: [post({ slug: "p1" })],
    prior: { lastDeliveredMonth: null, failedMonth: "2026-08", attempts: MAX_DELIVERY_ATTEMPTS - 1 },
    notify: async () => false,
  });
  await h.run();
  assert.equal(h.state.alerts.length, 1);
  const issue = h.state.alerts[0];
  assert.equal(issue.source, "review-delivery");
  assert.match(issue.kind, /undeliverable:better-life:2026-08/, "keyed so escalate dedupes it to ONE message");
  assert.match(issue.text, /START/, "must name the actual fix — the bot cannot message him until he starts it");
  assert.match(issue.text, /p1/, "and name what did not arrive");
});

test("a NEW month gets a fresh budget — a bad August must not mute September", async () => {
  assert.equal(shouldAttemptDelivery({ month: "2026-09", failedMonth: "2026-08", attempts: 99 }), true);
  assert.equal(shouldAttemptDelivery({ month: "2026-08", failedMonth: "2026-08", attempts: 0 }), true);
  assert.equal(shouldAttemptDelivery({ month: "2026-08", failedMonth: "2026-08", attempts: MAX_DELIVERY_ATTEMPTS, lastAttemptAt: NOW - 1000, nowMs: NOW }), false);
  assert.equal(shouldAttemptDelivery({ month: "2026-08", failedMonth: null, attempts: 0 }), true);
});

test("a successful batch clears the failure budget", async () => {
  const h = harness({
    deliver: [post()],
    prior: { lastDeliveredMonth: null, failedMonth: "2026-08", attempts: 2 },
    notify: async () => true,
  });
  await h.run();
  assert.equal(h.state.written, "2026-08", "a clean batch closes the month and resets the counters");
});

test("nothing due changes nothing at all", async () => {
  const h = harness({ deliver: [], monthlyBatch: false });
  const r = await h.run();
  assert.deepEqual(r.sent, []);
  assert.equal(h.state.saved, false);
  assert.equal(h.state.written, null);
});

// ── the weekly path is off, and reversible ───────────────────────────────────────────────────────

test("weekly delivery is OFF by default and flips back with one env var", () => {
  assert.equal(reviewDeliveryMode(() => ""), "monthly");
  assert.equal(weeklyDeliveryEnabled(() => ""), false);
  assert.equal(weeklyDeliveryEnabled(() => "monthly"), false);
  assert.equal(weeklyDeliveryEnabled(() => "weekly"), true);
  assert.equal(weeklyDeliveryEnabled(() => "WEEKLY"), true, "case must not decide behaviour");
  assert.equal(weeklyDeliveryEnabled(() => "  weekly  "), true);
  // anything unrecognised falls to the SAFE side (monthly), never to a surprise burst of messages
  assert.equal(weeklyDeliveryEnabled(() => "yes"), false);
});

test("NEGATIVE: in monthly mode the weekly path sends nothing and stamps nothing", async () => {
  const p = post();
  let notified = 0;
  const failed = await deliverReviewPhotos({
    brand: "better-life",
    posts: [p],
    notifyPhoto: async () => { notified += 1; return true; },
    photoPath: () => "/x.png",
    caption: () => "c",
    keyboard: () => ({}),
    enabled: () => false,
  });
  assert.deepEqual(failed, []);
  assert.equal(notified, 0, "generation must not deliver in monthly mode");
  assert.equal(p.review, undefined, "and must not stamp, or the monthly deliverer will never find it");
});

test("CONTROL: with weekly mode on, the old behaviour is intact", async () => {
  const p = post();
  let notified = 0;
  await deliverReviewPhotos({
    brand: "better-life",
    posts: [p],
    notifyPhoto: async () => { notified += 1; return true; },
    photoPath: () => "/x.png",
    caption: () => "c",
    keyboard: () => ({}),
    enabled: () => true,
    now: NOW,
  });
  assert.equal(notified, 1);
  assert.ok(p.review?.sentAt, "the suite must not be able to pass by breaking delivery outright");
});

// ── wiring: every brand bot must actually call this ──────────────────────────────────────────────

// THE BUG THIS CATCHES (2026-08-04, found on the live run, not in review).
// The wiring passed `notifyPhoto` and `posterKeyboard` into deliverDueReviews in all four bots.
// Three of them imported those names; tml never had, because until delivery moved into the bot it
// had no reason to. Syntax was valid, --check passed, every unit test passed — and tml threw
// "notifyPhoto is not defined" at runtime and delivered nothing while the other three delivered.
// A name used but never imported is invisible to everything except execution, so assert it here.
test("every bot IMPORTS the names its delivery call uses", () => {
  // Was all four divorce-tenant bridges; pruned to Owl Standard only, which uses the shared
  // scripts/tg-bridge.mjs. The assertion below is unchanged and still catches the used-but-not-imported
  // bug this test was written for.
  const bridges = [
    ["../tg-bridge.mjs", "./lib/notify.mjs"],
  ];
  for (const [rel] of bridges) {
    const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const imported = [...source.matchAll(/^import\s*\{([^}]+)\}/gm)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]))
      .filter(Boolean);
    for (const name of ["notifyPhoto", "posterKeyboard", "deliverDueReviews"]) {
      assert.ok(imported.includes(name), `${rel} passes ${name} to deliverDueReviews but never imports it`);
    }
  }
});

test("the review bot delivers through its OWN bot, before the decision sweep", () => {
  const bridges = [
    ["../tg-bridge.mjs", "owl-standard"],
  ];
  for (const [rel, brand] of bridges) {
    const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    assert.match(source, /deliverDueReviews\(/, `${rel} must deliver its own batch`);
    assert.match(source, new RegExp(`brand: "${brand}"`), `${rel} must deliver as ${brand}`);
    // It must run BEFORE the decision sweep, which only looks at already-shown posts.
    assert.ok(source.indexOf("deliverDueReviews(") < source.indexOf("sweepReviewWeeks("),
      `${rel}: delivery must precede the decision sweep`);
  }
});
