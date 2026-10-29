// Wiring tests: prove the repair layer is CONNECTED, not merely correct in isolation.
//
// The 2026-07-30 lesson this file exists to honour: the defect lived in the one module with no test
// file, and the fix was only trusted once a test drove the real entry point and asserted on the
// transport — INCLUDING a negative test that unwired the channel and confirmed the signal disappeared.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// ── the ops bot routing fix ──────────────────────────────────────────────────────────────────────

test("alert.mjs sends through the DEDICATED ops bot, never a brand's token", async () => {
  const alert = await import("./alert.mjs");
  assert.equal(alert.OPS_TOKEN_ENV, "TELEGRAM_BOT_TOKEN__OPS");

  const source = repoFile("./alert.mjs");
  // The regression: `getEnv("TELEGRAM_BOT_TOKEN")` — @landlord_fbgroup_bot, a client brand bot.
  assert.doesNotMatch(
    source.replace(/^\s*\/\/.*$/gm, ""),          // comments explain the old value; code must not use it
    /getEnv\(\s*["']TELEGRAM_BOT_TOKEN["']\s*\)/,
    "alert.mjs must not read the shared brand token — that is how ops alarms ended up in the landlord bot",
  );
  // ...and no silent fallback to it either, which is how notify.mjs's identical bug used to work.
  assert.doesNotMatch(source, /OPS_TOKEN_ENV\s*\)\s*\|\|\s*getEnv\(/, "no fallback: a missing ops token must fail loudly");
});

test("NEGATIVE: with the ops channel unwired, the alarm reports failure loudly and stays retryable", async () => {
  const { createOpsTelegramSender } = await import("./alert.mjs");
  const lines = [];
  const sender = createOpsTelegramSender({
    token: "", chat: "12345",
    request: async () => { throw new Error("must not be called with no token"); },
    log: (line) => lines.push(line),
  });
  assert.equal(await sender("anything"), false);
  assert.ok(
    lines.some((l) => l.includes("ALERT_CHANNEL_UNCONFIGURED") && l.includes("TELEGRAM_BOT_TOKEN__OPS")),
    `must name the missing key; got ${JSON.stringify(lines)}`,
  );
  // The chat id is named too when it is the missing half.
  const lines2 = [];
  const s2 = createOpsTelegramSender({ token: "t", chat: "", request: async () => true, log: (l) => lines2.push(l) });
  assert.equal(await s2("x"), false);
  assert.ok(lines2.some((l) => l.includes("TELEGRAM_OWNER_CHAT_ID")));
});

test("the worker REFUSES TO BOOT without the ops alarm channel", () => {
  const source = repoFile("../render-worker.mjs");
  assert.match(source, /function assertOpsAlarmChannel/);
  assert.match(source, /refusing to start worker: .*missing, so no safety alarm could reach the owner/);
  // and it is actually CALLED — a guard that is defined but never invoked is the exact class of
  // false-green this repo keeps finding.
  assert.match(source, /assertOpsAlarmChannel\(\);/, "the guard must be invoked, not merely defined");
  const callIndex = source.indexOf("assertOpsAlarmChannel();");
  const botStart = source.indexOf("botSupervisor.start(bot)");
  assert.ok(callIndex > 0 && callIndex < botStart, "the guard must run BEFORE any bot starts");
});

// ── SCE-Repair is registered and sanely bounded ──────────────────────────────────────────────────

test("SCE-Repair is a registered worker job, non-publisher, hourly, with a finite ceiling", async () => {
  const { SCHEDULED_JOBS, cronMatches } = await import("./worker-jobs.mjs");
  const job = SCHEDULED_JOBS.find((j) => j.name === "SCE-Repair");
  assert.ok(job, "SCE-Repair must be registered or it never runs");
  assert.equal(job.entry, "scripts/repair.mjs");
  assert.equal(job.env, "JOB_SCE_REPAIR_ENABLED");
  assert.equal(job.publisher, false, "publisher:true would freeze it behind PUBLISHING_ENABLED — exactly when a stuck slot most needs clearing");
  assert.ok(Number.isFinite(job.maxRuntimeMs) && job.maxRuntimeMs > 0);
  assert.ok(job.maxRuntimeMs <= 20 * 60_000, "a repairer that can run for ages is a repairer that gets SIGTERMed");
  // hourly: matches exactly one minute per hour
  const matches = Array.from({ length: 60 }, (_, minute) => cronMatches(job.cron, { minute, hour: 3, day: 4, month: 8, dow: 2 }));
  assert.equal(matches.filter(Boolean).length, 1, "SCE-Repair should fire once an hour");
});

test("every registered job still has a finite ceiling (the new one included)", async () => {
  const { SCHEDULED_JOBS } = await import("./worker-jobs.mjs");
  for (const job of SCHEDULED_JOBS) {
    assert.ok(Number.isFinite(job.maxRuntimeMs) && job.maxRuntimeMs > 0, `${job.name} needs a positive maxRuntimeMs`);
  }
});

// ── the repairer's own wiring ────────────────────────────────────────────────────────────────────

test("repair.mjs is import-safe and exposes its sweeps for testing", async () => {
  process.env.SCE_IMPORT_ONLY = "1";
  const repair = await import("../repair.mjs");
  assert.equal(typeof repair.repairLedgerSlots, "function");
  assert.equal(typeof repair.repairBrokenContent, "function");
  assert.equal(typeof repair.runRepair, "function");
  assert.deepEqual([...repair.BRANDS], ["owl-standard"]);
});

test("ledger repair: CONFIRM adopts the slot AND writes the id back to the week manifest", async () => {
  process.env.SCE_IMPORT_ONLY = "1";
  const { repairLedgerSlots } = await import("../repair.mjs");
  const adopted = [];
  const released = [];
  const written = [];
  const post = { slug: "2026-W32-01", caption: "一個夠長嘅標題內容，用嚟識別呢個帖文", date: "2026-08-03" };
  // The repairer writes the manifest back to this path. A literal "/tmp/week.json" became
  // C:\tmp\week.json on Windows (nonexistent) -> ENOENT -> HOLD instead of the confirm under test.
  const weekPath = join(mkdtempSync(join(tmpdir(), "sce-repair-")), "week.json");

  const result = await repairLedgerSlots({
    state: { ledger: {}, content: {}, cursor: 0 },
    todayStr: "2026-08-04",
    findStale: () => [{
      brand: "owl-standard", slug: "2026-W32-01", channel: "ig", planned_date: "2026-08-03",
      status: "uncertain", claimed_at: "2026-08-01T02:05:00.000Z", age_ms: 3 * 24 * 3600_000,
    }],
    findPost: () => ({ post, week: { posts: [post] }, path: weekPath }),
    tokenFor: () => "a-token",
    lookupIg: async () => ({ state: "found", remoteId: "17900000000000000" }),
    adopt: (slot, remote) => { adopted.push({ slot, remote }); },
    release: (slot) => { released.push(slot); },
    log: () => {},
    record: (entry) => written.push(entry),
  });

  assert.equal(result.repaired.length, 1);
  assert.equal(result.repaired[0].action, "confirm");
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].remote.id, "17900000000000000");
  assert.equal(released.length, 0);
  assert.equal(post.igPostId, "17900000000000000", "the manifest must agree with the ledger or the publisher retries");
  assert.equal(written[0].repairer, "ledger");
});

test("NEGATIVE: an undetermined verdict releases NOTHING and asks for a person", async () => {
  process.env.SCE_IMPORT_ONLY = "1";
  const { repairLedgerSlots } = await import("../repair.mjs");
  let releases = 0, adoptions = 0;
  const result = await repairLedgerSlots({
    state: { ledger: {}, content: {}, cursor: 0 },
    todayStr: "2026-08-04",
    findStale: () => [{
      brand: "tml", slug: "2026-08-03-01", channel: "ig", planned_date: "2026-08-03",
      status: "uncertain", claimed_at: "2026-08-01T02:05:00.000Z", age_ms: 3 * 24 * 3600_000,
    }],
    findPost: () => ({ post: { slug: "2026-08-03-01", caption: "一個夠長嘅標題內容，用嚟識別呢個帖文" }, week: {}, path: "/x" }),
    tokenFor: () => "t",
    lookupIg: async () => ({ state: "undetermined", reason: "Meta instagram media read failed: fetch failed" }),
    adopt: () => { adoptions += 1; },
    release: () => { releases += 1; },
    log: () => {},
    record: () => {},
  });
  assert.equal(releases, 0, "an ambiguous read must never free a slot — that is the double-post window");
  assert.equal(adoptions, 0);
  assert.equal(result.held.length, 1);
  assert.equal(result.held[0].escalate, true);
});

test("NEGATIVE: a missing page token yields undetermined — never a release", async () => {
  process.env.SCE_IMPORT_ONLY = "1";
  const { repairLedgerSlots } = await import("../repair.mjs");
  let releases = 0;
  let lookupCalls = 0;
  const result = await repairLedgerSlots({
    state: { ledger: {}, content: {}, cursor: 0 },
    todayStr: "2026-08-04",
    findStale: () => [{
      brand: "better-life", slug: "s", channel: "ig", planned_date: "2026-08-03",
      status: "uncertain", claimed_at: "2026-08-01T00:00:00.000Z", age_ms: 3 * 24 * 3600_000,
    }],
    findPost: () => ({ post: { slug: "s", caption: "一個夠長嘅標題內容，用嚟識別呢個帖文" }, week: {}, path: "/x" }),
    tokenFor: () => "",
    lookupIg: async () => { lookupCalls += 1; return { state: "absent" }; },
    release: () => { releases += 1; },
    adopt: () => {},
    log: () => {},
    record: () => {},
  });
  assert.equal(lookupCalls, 0, "must not pretend to have asked Meta");
  assert.equal(releases, 0);
  assert.equal(result.held[0].escalate, true);
});

test("dry mode changes nothing at all", async () => {
  process.env.SCE_IMPORT_ONLY = "1";
  const { repairLedgerSlots } = await import("../repair.mjs");
  let mutations = 0;
  const result = await repairLedgerSlots({
    dry: true,
    state: { ledger: {}, content: {}, cursor: 0 },
    todayStr: "2026-08-04",
    findStale: () => [{
      brand: "better-life", slug: "s", channel: "ig", planned_date: "2026-08-03",
      status: "uncertain", claimed_at: "2026-08-01T00:00:00.000Z", age_ms: 3 * 24 * 3600_000,
    }],
    findPost: () => ({ post: { slug: "s", caption: "一個夠長嘅標題內容，用嚟識別呢個帖文" }, week: {}, path: "/x" }),
    tokenFor: () => "t",
    lookupIg: async () => ({ state: "absent" }),
    adopt: () => { mutations += 1; },
    release: () => { mutations += 1; },
    log: () => {},
    record: () => { mutations += 1; },
  });
  assert.equal(mutations, 0, "--dry must be safe to run against production state");
  assert.equal(result.repaired[0].dry, true);
});

// ── content repair boundaries ────────────────────────────────────────────────────────────────────

test("content repair registry: only brands verified end to end are auto-regenerated", async () => {
  const { CONTENT_REPAIR_REGISTRY, isContentRepairSupported } = await import("./content-repair.mjs");
  // owl-standard is deliberately supported:false until scripts/owl-standard/gen-week.mjs exists and its
  // three repair steps are checked against the real script. This test is the thing that will fail if
  // someone flips it to true without doing that — the whole point of the registry being a boundary.
  for (const brand of Object.keys(CONTENT_REPAIR_REGISTRY)) {
    const entry = CONTENT_REPAIR_REGISTRY[brand];
    if (entry.supported) {
      assert.ok(entry.note && entry.note.length > 20, `${brand} claims supported — it must name the verified steps`);
    } else {
      assert.equal(isContentRepairSupported(brand), false);
      assert.ok(entry.reason.length > 20, `${brand} must carry a readable reason, not a bare false`);
    }
  }
  assert.equal(isContentRepairSupported("nonexistent"), false);
});

test("an unsupported brand reports a reason and never claims success", async () => {
  const { regenerateContent } = await import("./content-repair.mjs");
  // Every real brand is supported again now that owl-standard's generator exists, so this asserts the
  // contract with an injected unsupported entry — the branch, not any particular brand.
  const result = await regenerateContent("stub-unsupported", { slug: "2026-08-03-01" }, {
    registry: { "stub-unsupported": { supported: false, reason: "test-only stub: this brand was never verified end to end" } },
    loadLedger: () => [{ id: "2026-08-03-01", title: "x" }],
    writeCaption: async () => { throw new Error("must not be called"); },
    deriveConcept: async () => { throw new Error("must not be called"); },
    writeConceptFile: () => { throw new Error("must not be called"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.match(result.reason, /never verified end to end/);
});

test("NEGATIVE: content repair refuses to invent a topic when the ledger has none", async () => {
  const { regenerateContent, topicForBrokenPost } = await import("./content-repair.mjs");
  assert.equal(topicForBrokenPost({ slug: "missing" }, [{ id: "other", title: "t" }]), null);
  // Inject a supported brand: the branch under test sits AFTER the supported check, and the real
  // registry currently marks every brand unsupported (owl-standard's generator does not exist yet).
  const result = await regenerateContent("fake-supported", { slug: "missing" }, {
    registry: { "fake-supported": { supported: true, note: "test-only stub for the no-topic branch" } },
    loadLedger: () => [],
    writeCaption: async () => { throw new Error("must not be called"); },
    deriveConcept: async () => { throw new Error("must not be called"); },
    writeConceptFile: () => { throw new Error("must not be called"); },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /refusing to invent one/);
});

test("the reserved topic is recovered from the ledger, not re-proposed", async () => {
  const { topicForBrokenPost } = await import("./content-repair.mjs");
  const post = { slug: "2026-W32-01", angle: "practical", status: "failed", error: "Anthropic 400: credits" };
  const topic = topicForBrokenPost(post, [{ id: "2026-W32-01", title: "離婚後份物業點算", angle: "practical" }]);
  assert.deepEqual(topic, { title: "離婚後份物業點算", angle: "practical" });
});

// ── poster-qa starvation fix ─────────────────────────────────────────────────────────────────────

test("poster-qa-sweep rotates brands and stops before its ceiling", () => {
  const source = repoFile("../poster-qa-sweep.mjs");
  assert.match(source, /rotateForFairness\(BRANDS, cursor\)/, "a fixed brand order starves the tail on every timeout");
  assert.match(source, /TIME_BUDGET_MS/, "it must stop on its own terms rather than be SIGTERMed");
  assert.match(source, /out-of-time/, "running out of time must itself be reported");
  assert.match(source, /writeCursor\(advanceCursor\(/, "the next run must start where this one stopped");
});

test("the poster-qa time budget leaves real headroom under the job ceiling", async () => {
  const { SCHEDULED_JOBS } = await import("./worker-jobs.mjs");
  const job = SCHEDULED_JOBS.find((j) => j.name === "SCE-PosterQA");
  const source = repoFile("../poster-qa-sweep.mjs");
  const budget = Number(source.match(/\|\|\s*(\d+)\s*\*\s*60_000/)?.[1]) * 60_000;
  assert.ok(Number.isFinite(budget) && budget > 0, "could not read the sweep's time budget");
  assert.ok(budget < job.maxRuntimeMs, "the voluntary stop must come BEFORE the SIGTERM, or it never fires");
  assert.ok(job.maxRuntimeMs - budget >= 4 * 60_000, "leave headroom for the in-flight poster to finish");
});
