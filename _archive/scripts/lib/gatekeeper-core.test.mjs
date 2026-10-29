import { test } from "node:test";
import assert from "node:assert/strict";
import {
  triageTask, triageCoverage, buildDigest, updatePersistence,
  nextMondays, furthestScheduled, looksObsoleteBrowserTask,
  classifyRemediation, planAutoSafeFix, stampRemediation,
} from "./gatekeeper-core.mjs";

test("benign / disabled tasks produce no finding", () => {
  assert.equal(triageTask({ name: "SCE-Watchdog", state: "Ready", lastResult: 0 }), null);
  assert.equal(triageTask({ name: "SCE-Catchup", state: "Running", lastResult: 0x41301 }), null);
  assert.equal(triageTask({ name: "TML-AutoSchedule", state: "Disabled", lastResult: 1 }), null);
});

test("obsolete browser task → recommend Disable-ScheduledTask", () => {
  const f = triageTask({ name: "BetterLife-AutoSchedule", state: "Ready", lastResult: 1, hex: "0x1", action: "node scripts/better-life/schedule-week.mjs", days: 4 });
  assert.equal(f.severity, "red"); // persisted ≥3 days → louder
  assert.match(f.recommendation, /Disable-ScheduledTask/);
  assert.ok(looksObsoleteBrowserTask("...playwright..."));
  assert.ok(looksObsoleteBrowserTask("...Business Suite..."));
  assert.ok(!looksObsoleteBrowserTask("node scripts/catchup.mjs"));
});

test("monitor exit-2 is the 'found+escalated' signal → benign, not a failure", () => {
  // task-health / gatekeeper exit code 2 BY DESIGN when they escalate findings — that's working, not broken.
  assert.equal(triageTask({ name: "SCE-TaskHealth", state: "Ready", lastResult: 2, hex: "0x2", action: "cmd.exe /c node task-health.mjs >> log 2>&1", days: 1 }), null);
});

test("a monitor crashing with a non-signal code → who-watches-the-watcher finding", () => {
  const f = triageTask({ name: "SCE-TaskHealth", state: "Ready", lastResult: 1, hex: "0x1", action: "cmd.exe /c node task-health.mjs >> log 2>&1", days: 1 });
  assert.equal(f.severity, "amber"); // day 1 → note
  assert.match(f.title, /監察/);
});

test("day-1 task finding is amber, day-3+ is red", () => {
  const base = { name: "X-Job", state: "Ready", lastResult: 1, hex: "0x1", action: "node scripts/x.mjs" };
  assert.equal(triageTask({ ...base, days: 1 }).severity, "amber");
  assert.equal(triageTask({ ...base, days: 3 }).severity, "red");
});

test("coverage: empty Monday (no scheduled, no backlog) → red gap", () => {
  const brand = { id: "tml", label: "TML", posts: [{ date: "2026-07-13", fbPostId: "1" }] };
  const f = triageCoverage(brand, ["2026-06-29", "2026-07-06"]);
  assert.equal(f.severity, "red");
  assert.match(f.title, /冇內容/);
});

test("coverage: backlog-only Monday → amber (auto top-up)", () => {
  const brand = { id: "bd", label: "BD", posts: [{ date: "2026-06-29", status: "pending" }] };
  const f = triageCoverage(brand, ["2026-06-29"]);
  assert.equal(f.severity, "amber");
});

test("coverage: scheduled Mondays → no finding", () => {
  const brand = { id: "s", label: "S", posts: [{ date: "2026-06-29", fbPostId: "a" }, { date: "2026-07-06", fbPostId: "b" }] };
  assert.equal(triageCoverage(brand, ["2026-06-29", "2026-07-06"]), null);
});

test("buildDigest: worst severity wins; healthy when empty", () => {
  assert.equal(buildDigest([]).overall, "green");
  assert.equal(buildDigest([{ severity: "amber", key: "a" }]).overall, "amber");
  const d = buildDigest([{ severity: "amber", key: "a" }, { severity: "red", key: "b" }]);
  assert.equal(d.overall, "red");
  assert.equal(d.findings[0].severity, "red"); // reds first
});

test("updatePersistence: bumps day on a new calendar day, holds same day, resets on clear", () => {
  let s = updatePersistence({}, ["k"], "2026-06-26");
  assert.equal(s.k.days, 1);
  s = updatePersistence(s, ["k"], "2026-06-26"); // same day → hold
  assert.equal(s.k.days, 1);
  s = updatePersistence(s, ["k"], "2026-06-27"); // next day → bump
  assert.equal(s.k.days, 2);
  s = updatePersistence(s, [], "2026-06-28");    // cleared → dropped
  assert.equal(s.k, undefined);
});

test("nextMondays returns the upcoming Mondays from a Friday", () => {
  assert.deepEqual(nextMondays("2026-06-26", 2), ["2026-06-29", "2026-07-06"]); // Fri → next 2 Mondays
  assert.deepEqual(nextMondays("2026-06-29", 1), ["2026-06-29"]);               // a Monday includes itself
});

test("furthestScheduled finds the latest fbPostId-bearing date", () => {
  const brands = [{ posts: [{ date: "2026-07-06", fbPostId: "1" }, { date: "2026-07-20", fbPostId: "2" }, { date: "2026-08-01" }] }];
  assert.equal(furthestScheduled(brands), "2026-07-20");
});

// ───────────────────────── REMEDIATION CLASSIFICATION (level b self-healing) ─────────────────────────

test("triage findings carry a `kind` discriminator the classifier reads", () => {
  // task: transient unknown enabled failure
  const t = triageTask({ name: "X-Job", state: "Ready", lastResult: 1, hex: "0x1", action: "node scripts/x.mjs", days: 1 });
  assert.equal(t.kind, "task-failure");
  assert.equal(t.taskName, "X-Job");
  // task: obsolete browser
  const ob = triageTask({ name: "BL-AutoSchedule", state: "Ready", lastResult: 1, action: "node scripts/better-life/schedule-week.mjs", days: 1 });
  assert.equal(ob.kind, "obsolete-task");
  // task: monitor crash (non-2 code)
  const mc = triageTask({ name: "SCE-TaskHealth", state: "Ready", lastResult: 1, hex: "0x1", action: "node task-health.mjs", days: 1 });
  assert.equal(mc.kind, "monitor-crash");
  // coverage gap vs backlog
  const gap = triageCoverage({ id: "tml", label: "TML", posts: [{ date: "2026-07-13", fbPostId: "1" }] }, ["2026-06-29"]);
  assert.equal(gap.kind, "gap");
  assert.equal(gap.brand, "tml");
  const back = triageCoverage({ id: "bd", label: "BD", posts: [{ date: "2026-06-29", status: "pending" }] }, ["2026-06-29"]);
  assert.equal(back.kind, "backlog");
});

test("classifyRemediation: AUTO-SAFE only for the 2 whitelisted cases", () => {
  // (i) transient (day-1) enabled non-obsolete task failure → auto-safe re-run
  assert.equal(classifyRemediation({ area: "task", kind: "task-failure", days: 1 }), "auto-safe");
  // (ii) backlog-only coverage → auto-safe fb-topup
  assert.equal(classifyRemediation({ area: "coverage", kind: "backlog", days: 1 }), "auto-safe");
});

test("classifyRemediation: a PERSISTED task failure is no longer transient → agent-verify, not another blind re-run", () => {
  assert.equal(classifyRemediation({ area: "task", kind: "task-failure", days: 2 }), "agent-verify");
  assert.equal(classifyRemediation({ area: "task", kind: "task-failure", days: 5 }), "agent-verify");
});

test("classifyRemediation: monitor-crash and zeroweek → agent-verify (read-only diagnosis)", () => {
  assert.equal(classifyRemediation({ area: "task", kind: "monitor-crash", days: 1 }), "agent-verify");
  assert.equal(classifyRemediation({ area: "generation", kind: "zeroweek", days: 1 }), "agent-verify");
});

test("classifyRemediation: everything destructive / money-spending / obsolete → ESCALATE", () => {
  assert.equal(classifyRemediation({ area: "task", kind: "obsolete-task", days: 1 }), "escalate"); // disabling = destructive
  assert.equal(classifyRemediation({ area: "coverage", kind: "gap", days: 1 }), "escalate");       // no backlog to schedule
  assert.equal(classifyRemediation({ area: "generation", kind: "billing", days: 1 }), "escalate"); // spends money
  // unknown area / kind → safest default
  assert.equal(classifyRemediation({ area: "task", kind: "mystery", days: 1 }), "escalate");
  assert.equal(classifyRemediation({ area: "weird", kind: "x", days: 1 }), "escalate");
  assert.equal(classifyRemediation(null), "escalate");
});

test("planAutoSafeFix: builds ONLY the 2 whitelisted plan shapes; null for everything else", () => {
  const rerun = planAutoSafeFix({ area: "task", kind: "task-failure", days: 1, taskName: "X-Job" });
  assert.deepEqual({ type: rerun.type, taskName: rerun.taskName }, { type: "rerun-task", taskName: "X-Job" });
  const topup = planAutoSafeFix({ area: "coverage", kind: "backlog", days: 1, brand: "tml" });
  assert.deepEqual({ type: topup.type, brand: topup.brand }, { type: "fb-topup", brand: "tml" });
  // not auto-safe → no plan (hard second gate)
  assert.equal(planAutoSafeFix({ area: "generation", kind: "billing", days: 1 }), null);
  assert.equal(planAutoSafeFix({ area: "task", kind: "obsolete-task", days: 1, taskName: "Y" }), null);
  assert.equal(planAutoSafeFix({ area: "coverage", kind: "gap", days: 1, brand: "tml" }), null);
});

test("planAutoSafeFix: POSTING_FROZEN blocks the fb-topup fix (never schedule while frozen)", () => {
  assert.equal(planAutoSafeFix({ area: "coverage", kind: "backlog", days: 1, brand: "tml" }, { frozen: true }), null);
  // a task re-run is unaffected by the posting freeze (it doesn't post)
  assert.ok(planAutoSafeFix({ area: "task", kind: "task-failure", days: 1, taskName: "X-Job" }, { frozen: true }));
});

test("stampRemediation: annotates each finding with class + plan; frozen downgrades fb-topup to escalate", () => {
  const findings = [
    { area: "task", kind: "task-failure", days: 1, taskName: "X-Job", severity: "amber" },
    { area: "coverage", kind: "backlog", days: 1, brand: "tml", severity: "amber" },
    { area: "generation", kind: "billing", days: 1, severity: "red" },
  ];
  const live = stampRemediation(findings, { frozen: false });
  assert.equal(live[0].remediation, "auto-safe");
  assert.equal(live[0].plan.type, "rerun-task");
  assert.equal(live[1].remediation, "auto-safe");
  assert.equal(live[1].plan.type, "fb-topup");
  assert.equal(live[2].remediation, "escalate");
  assert.equal(live[2].plan, null);

  // Frozen → the fb-topup finding has no buildable plan → DOWNGRADED to escalate (fail-safe).
  const frozen = stampRemediation(findings, { frozen: true });
  assert.equal(frozen[1].remediation, "escalate");
  assert.equal(frozen[1].plan, null);
  // The task re-run is still auto-safe (not a posting action).
  assert.equal(frozen[0].remediation, "auto-safe");
});

test("stampRemediation: never invents a plan for an escalate/agent-verify finding", () => {
  const out = stampRemediation([
    { area: "task", kind: "obsolete-task", days: 4, taskName: "Z", severity: "red" },
    { area: "task", kind: "monitor-crash", days: 1, taskName: "M", severity: "amber" },
  ]);
  assert.equal(out[0].remediation, "escalate");
  assert.equal(out[0].plan, null);
  assert.equal(out[1].remediation, "agent-verify"); // monitor-crash → diagnose (read-only); never auto-acted by the Gatekeeper
  assert.equal(out[1].plan, null);
});

// The Gatekeeper NEVER auto-re-registers a crashed monitor (that needs admin). It classifies it agent-verify
// and escalates — the single elevated repairer is task-health. So the Gatekeeper stays advisory / Limited.
test("classifyRemediation: ANY crashed monitor → agent-verify (Gatekeeper never re-registers; task-health does)", () => {
  assert.equal(classifyRemediation({ area: "task", kind: "monitor-crash", taskName: "SCE-Gatekeeper", days: 1 }), "agent-verify");
  assert.equal(classifyRemediation({ area: "task", kind: "monitor-crash", taskName: "SCE-TaskHealth", days: 1 }), "agent-verify");
  assert.equal(classifyRemediation({ area: "task", kind: "monitor-crash", days: 5 }), "agent-verify");
});

test("planAutoSafeFix: a monitor-crash NEVER builds a plan (no elevated re-register in the Gatekeeper)", () => {
  assert.equal(planAutoSafeFix({ area: "task", kind: "monitor-crash", taskName: "SCE-Gatekeeper", days: 1 }), null);
  assert.equal(planAutoSafeFix({ area: "task", kind: "monitor-crash", taskName: "SCE-TaskHealth", days: 1 }), null);
});
