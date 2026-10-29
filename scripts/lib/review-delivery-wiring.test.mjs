// review-delivery-wiring.test.mjs
//
// WHY THIS EXISTS (2026-07-30)
//   B3 moved review stamping behind confirmed delivery: lib/review-delivery.mjs stamps a post
//   ONLY when notifyPhoto() returns truthy, and alarms on the ones it could not deliver. Before
//   that, the four weekly-runs called stampReview() BEFORE notifyPhoto() and discarded its return,
//   so the 48-hour auto-approve clock started on ATTEMPT rather than delivery — and 48h later a
//   post the owner never saw would auto-approve itself.
//
//   review-delivery.test.mjs proves the helper is CORRECT. Nothing proved it was USED.
//
//   That distinction is not academic here. The live 2026-07-30 bot outage was caused by exactly
//   this gap: TELEGRAM_LONG_POLL_TIMEOUT_MS (65s) existed and was correct, but was wired only into
//   lib/review-bot-runtime.mjs, which the four bots did not import. So every 50s long poll ran on
//   the 15s default and aborted. A correct fix that nothing calls is not a fix.
//
//   So this test asserts the WIRING, per the workspace law that a gate must declare the surface it
//   measures and that enforcement must reach every copy of a path. If any brand's weekly-run stops
//   routing review photos through the delivery gate, or reintroduces a bare stampReview() next to
//   its own notify call, this fails.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCHEDULED_JOBS } from "./worker-jobs.mjs";

// Was the four divorce tenants' weekly-run.mjs files; this checkout was pruned to Owl Standard only.
// The anti-vacuity test below keeps this list honest against the scheduled-jobs table.
const WEEKLY_RUNS = [
  "scripts/owl-standard/weekly-run.mjs",
];

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

// Anti-vacuity guard: the three wiring tests below iterate WEEKLY_RUNS, so an empty list makes them all
// pass without checking anything. This test fails the moment a weekly-run job is scheduled but missing
// from WEEKLY_RUNS — i.e. it converts "silently unprotected" into a red test.
test("WEEKLY_RUNS covers every scheduled weekly-run job (no vacuous wiring checks)", () => {
  const scheduled = SCHEDULED_JOBS
    .filter((job) => job.entry.endsWith("/weekly-run.mjs"))
    .map((job) => job.entry)
    .sort();
  assert.deepEqual(
    [...WEEKLY_RUNS].sort(),
    scheduled,
    "a weekly-run is scheduled but not listed in WEEKLY_RUNS — the delivery-gate wiring tests below would " +
    "skip it entirely. Add it to WEEKLY_RUNS.",
  );
});

test("every weekly autopilot is a registered, non-publishing scheduled job", () => {
  for (const entry of WEEKLY_RUNS) {
    const job = SCHEDULED_JOBS.find((j) => j.entry === entry);
    assert.ok(job, `${entry} must be a registered scheduled job`);
    assert.equal(job.publisher, false, `${entry} must not be marked a publisher`);
  }
});

test("every weekly autopilot routes review photos through the delivery gate", () => {
  for (const entry of WEEKLY_RUNS) {
    const source = read(entry);
    assert.match(
      source,
      /import\s+\{[^}]*deliverReviewPhotos[^}]*\}\s+from\s+["'][^"']*review-delivery\.mjs["']/,
      `${entry} must import deliverReviewPhotos from lib/review-delivery.mjs`,
    );
    assert.match(
      source,
      /deliverReviewPhotos\s*\(/,
      `${entry} must actually CALL deliverReviewPhotos — importing it is not using it`,
    );
  }
});

test("no weekly autopilot starts the review clock itself", () => {
  // The clock may only be started by the delivery gate, which starts it on confirmed delivery.
  // A weekly-run calling stampReview directly would reintroduce start-on-attempt.
  for (const entry of WEEKLY_RUNS) {
    const source = read(entry);
    assert.doesNotMatch(
      source,
      /\bstampReview\s*\(/,
      `${entry} must not call stampReview directly — only lib/review-delivery.mjs may start the 48h clock`,
    );
  }
});

test("the delivery gate stamps only on success and alarms on failure", () => {
  // Guards the helper's contract itself, so this file fails if the gate is hollowed out while the
  // call sites still look correct — the false-green shape this repo has shipped four times.
  const source = read("scripts/lib/review-delivery.mjs");
  assert.match(source, /const\s+delivered\s*=\s*await\s+notifyPhoto\(/);
  assert.match(source, /if\s*\(delivered\)\s*stamp\(/, "stamping must be conditional on delivery");
  assert.match(source, /failedSlugs\.push\(/, "undelivered posts must be collected");
  assert.match(source, /severity:\s*["']crucial["']/, "a delivery failure must alarm at crucial severity");
});
