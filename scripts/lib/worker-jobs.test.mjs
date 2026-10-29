import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cronMatches,
  enabled,
  MAX_CONCURRENT_HEAVY_JOBS,
  REVIEW_BOTS,
  SCHEDULED_JOBS,
  zonedMinute,
} from "./worker-jobs.mjs";

const BASELINE = JSON.parse(
  readFileSync(new URL("./worker-jobs.baseline.json", import.meta.url), "utf8"),
);

function pinnedFields({ name, entry, cron, env, publisher }) {
  return { name, entry, cron, env, publisher };
}

function assertExistingJobBaseline(jobs) {
  assert.deepEqual(
    jobs.slice(0, BASELINE.length).map(pinnedFields),
    BASELINE,
    "the pre-existing jobs must not change — append new jobs, never edit these",
  );
  assert.ok(jobs.length >= BASELINE.length, "the pre-existing jobs must not be removed");
}

test("the pre-existing scheduled jobs are immutable and new jobs may only be appended", () => {
  assertExistingJobBaseline(SCHEDULED_JOBS);
});

test("the immutable baseline rejects a changed cron in an existing entry", () => {
  const scratch = SCHEDULED_JOBS.map((job) => ({ ...job }));
  scratch[0].cron = "1 8 * * *";
  assert.throws(
    () => assertExistingJobBaseline(scratch),
    { name: "AssertionError" },
  );
});

test("exactly the Owl Standard job set is registered, so an extra job has to be added deliberately", () => {
  // An EXACT list, not a minimum: every scheduled job costs worker time and some can touch live accounts.
  // Golf For Travellers (another client) and the Windows-only Gatekeeper were removed on 2026-09-18.
  assert.deepEqual(SCHEDULED_JOBS.map((job) => job.name), [
    "SCE-Preflight", "SCE-Catchup", "OwlStandard-WeeklyAutopilot", "SCE-FB-Topup", "OwlStandard-IG-Daily",
    "SCE-PosterQA", "SCE-Repair", "SCE-ContactSheet",
  ]);
});

test("every scheduled job has a finite maximum runtime and publishers have tighter ceilings", () => {
  for (const job of SCHEDULED_JOBS) {
    assert.equal(Number.isFinite(job.maxRuntimeMs) && job.maxRuntimeMs > 0, true, job.name);
  }
  assert.equal(SCHEDULED_JOBS.find((job) => job.name === "SCE-Catchup").maxRuntimeMs, 55 * 60_000);
  for (const job of SCHEDULED_JOBS.filter((candidate) => candidate.publisher && candidate.name !== "SCE-FB-Topup")) {
    assert.equal(job.maxRuntimeMs, 5 * 60_000, job.name);
  }
});

test("every scheduled job defaults disabled and malformed values stay disabled", () => {
  for (const job of SCHEDULED_JOBS) {
    assert.equal(enabled(job, { env: {}, read: () => "" }), false, job.name);
    assert.equal(enabled(job, { env: { [job.env]: "1" }, read: () => "" }), false, job.name);
    assert.equal(enabled(job, { env: { [job.env]: "yes" }, read: () => "" }), false, job.name);
    assert.equal(enabled(job, { env: { [job.env]: "true" }, read: () => "" }), true, job.name);
  }
});

test("publisher jobs are a second gate behind PUBLISHING_ENABLED", () => {
  const publishers = SCHEDULED_JOBS.filter((job) => job.publisher);
  // Originally also listed the four divorce-tenant publisher jobs (Sunmood/BrightDay-AutoSchedule,
  // TML/BetterLife-IG-Daily) — removed along with their entries when this checkout was pruned to Owl
  // Standard only. Add Owl Standard's own publisher job name here once it exists.
  assert.deepEqual(
    publishers.map((job) => job.name),
    ["SCE-FB-Topup", "OwlStandard-IG-Daily"],
  );
});

test("the review bot registry uses distinct per-brand token variables and defaults off", () => {
  // Was "four review bots" (one per divorce tenant) before the prune; now just Owl Standard's.
  assert.equal(REVIEW_BOTS.length, 1);
  assert.equal(new Set(REVIEW_BOTS.map((bot) => bot.brand)).size, REVIEW_BOTS.length);
  assert.equal(new Set(REVIEW_BOTS.map((bot) => bot.tokenEnv)).size, REVIEW_BOTS.length);
  assert.equal(new Set(REVIEW_BOTS.map((bot) => bot.fbTokenEnv)).size, REVIEW_BOTS.length);
  for (const bot of REVIEW_BOTS) assert.equal(enabled(bot, { env: {}, read: () => "" }), false);
});

test("DEFECT 3: exactly the Thursday-18:00 WeeklyAutopilot is marked heavy", () => {
  // Originally guarded four divorce-tenant autopilots sharing "0 18 * * 4" — a real OOM risk on the
  // 512MB worker. Owl Standard's autopilot inherits the slot and the risk (3 image renders per run),
  // so it carries heavy:true. Nothing else should be swept in by accident.
  const heavyNames = SCHEDULED_JOBS.filter((job) => job.heavy).map((job) => job.name).sort();
  assert.deepEqual(heavyNames, ["OwlStandard-WeeklyAutopilot"]);
  for (const job of SCHEDULED_JOBS.filter((candidate) => candidate.heavy)) {
    assert.equal(job.cron, "0 18 * * 4", job.name);
  }
});

test("MAX_CONCURRENT_HEAVY_JOBS is a small positive number", () => {
  // The "< heavyCount" comparison from before the prune is meaningless with zero heavy jobs contending —
  // restore it once Owl Standard's autopilot (or anything else) is marked heavy again.
  assert.equal(Number.isInteger(MAX_CONCURRENT_HEAVY_JOBS) && MAX_CONCURRENT_HEAVY_JOBS > 0, true);
});

test("cron matcher preserves Hong Kong trigger minutes", () => {
  const thu1800 = zonedMinute(new Date("2026-07-30T10:00:00Z"));
  assert.equal(cronMatches("0 18 * * 4", thu1800), true);
  assert.equal(cronMatches("0 18 * * 0", thu1800), false);
  const daily0930 = zonedMinute(new Date("2026-07-30T01:30:00Z"));
  assert.equal(cronMatches("30 9 * * *", daily0930), true);
  assert.equal(cronMatches("0 */2 * * *", daily0930), false);
  const daily1005 = zonedMinute(new Date("2026-07-30T02:05:00Z"));
  assert.equal(cronMatches("5 10 * * *", daily1005), true);
  // Was two "*-IG-Daily" jobs (TML/BetterLife); Owl Standard's is the one that replaced them, on the
  // same 10:05 HK trigger.
  assert.deepEqual(
    SCHEDULED_JOBS.filter((job) => job.name.endsWith("IG-Daily")).map((job) => job.cron),
    ["5 10 * * *"],
  );
});
