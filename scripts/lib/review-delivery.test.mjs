import test from "node:test";
import assert from "node:assert/strict";
import { deliverReviewPhotos } from "./review-delivery.mjs";

test("failed photo delivery leaves the post unstamped and raises an alarm naming the slug", async () => {
  const post = { slug: "2026-W32-01", status: "generated" };
  const alerts = [];
  let stamps = 0;
  const failed = await deliverReviewPhotos({
    brand: "tml",
    posts: [post],
    notifyPhoto: async () => false,
    photoPath: () => "poster.png",
    caption: () => "caption",
    keyboard: () => ({ inline_keyboard: [] }),
    now: 123,
    stamp: () => { stamps += 1; },
    alert: async (issue) => { alerts.push(issue); return true; },
    // weekly mode: this test is about the transport, not the monthly/weekly switch.
    enabled: () => true,
  });

  assert.deepEqual(failed, ["2026-W32-01"]);
  assert.equal(stamps, 0);
  assert.equal(post.review, undefined);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /2026-W32-01/);
  assert.match(alerts[0].text, /clock was not started/i);
});

test("only confirmed deliveries are stamped and failures do not stop later attempts", async () => {
  const posts = [
    { slug: "failed-first", status: "generated" },
    { slug: "delivered-second", status: "generated" },
  ];
  const attempts = [];
  const alerts = [];
  const failed = await deliverReviewPhotos({
    brand: "sunmood",
    posts,
    notifyPhoto: async (path) => {
      attempts.push(path);
      return path.includes("delivered-second");
    },
    photoPath: (post) => `${post.slug}.png`,
    caption: (post) => post.slug,
    keyboard: (slug) => slug,
    now: 456,
    alert: async (issue) => { alerts.push(issue); return true; },
    // weekly mode: this test is about the transport, not the monthly/weekly switch.
    enabled: () => true,
  });

  assert.deepEqual(attempts, ["failed-first.png", "delivered-second.png"]);
  assert.deepEqual(failed, ["failed-first"]);
  assert.equal(posts[0].review, undefined);
  assert.equal(posts[1].review.sentAt, 456);
  assert.equal(alerts.length, 1);
});

// The "all four weekly runners use the shared delivery-confirmed review gate" test was removed here: it
// read the four divorce tenants' weekly-run.mjs files, which no longer exist after the prune to Owl
// Standard. Its call-site coverage is not lost — review-delivery-wiring.test.mjs makes the same
// assertions over the same list and now carries an anti-vacuity guard that fails if a scheduled
// weekly-run is missing from it. The tests above still cover this helper's own contract.
