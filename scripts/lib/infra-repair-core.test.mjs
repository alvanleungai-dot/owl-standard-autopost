import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INFRA_REPAIR_REGISTRY, isInfraRepairable, planInfraRepair,
  shouldAttemptRepair, recordRepairAttempt,
  looksCorrectlyQuoted, verifyReregister,
} from "./infra-repair-core.mjs";

// Correct (outer-quoted) cmd action — what the committed register-*.ps1 scripts produce.
const GOOD = `/c ""C:\\Program Files\\nodejs\\node.exe" "C:\\x\\gatekeeper.mjs" >> "C:\\x\\g.log" 2>&1"`;
// The 2026-06-28 bug: the inner cmd is NOT wrapped in an outer quote pair → node path splits at the space.
const BROKEN = `/c "C:\\Program Files\\nodejs\\node.exe" "C:\\x\\gatekeeper.mjs" >> "C:\\x\\g.log" 2>&1`;

test("looksCorrectlyQuoted: true for the outer-quoted cmd form, false for the broken collapse", () => {
  assert.equal(looksCorrectlyQuoted(GOOD), true);
  assert.equal(looksCorrectlyQuoted(BROKEN), false);
  // N/A for a non-cmd action (don't fail a task whose action isn't a cmd /c wrapper)
  assert.equal(looksCorrectlyQuoted("C:\\Program Files\\nodejs\\node.exe x.mjs"), true);
});

test("verifyReregister: ok only when present, enabled, AND correctly quoted", () => {
  assert.equal(verifyReregister({ present: true, state: "Ready", actionArgs: GOOD }).ok, true);
  assert.equal(verifyReregister({ present: false }).ok, false);                                  // gone
  assert.equal(verifyReregister({ present: true, state: "Disabled", actionArgs: GOOD }).ok, false); // disabled
  assert.equal(verifyReregister({ present: true, state: "Ready", actionArgs: BROKEN }).ok, false);  // still mis-quoted
});

// ── The registry is the SAFETY BOUNDARY: only deterministic monitor/infra tasks that have a committed
// register-*.ps1 may be auto-re-registered. It must NEVER contain a posting / generation / browser task.
test("registry contains ONLY monitor/infra tasks, never a posting/generation/browser task", () => {
  const names = Object.keys(INFRA_REPAIR_REGISTRY);
  assert.ok(names.length > 0, "registry should not be empty");
  for (const n of names) {
    assert.doesNotMatch(n, /post|gen|autopilot|autoschedule|ig-daily|feedback/i,
      `${n} is not an infra/monitor task and must not be auto-repairable`);
  }
  // Every entry points at a committed windows/register-*.ps1 script and carries a human label.
  for (const [n, spec] of Object.entries(INFRA_REPAIR_REGISTRY)) {
    assert.match(spec.script, /^windows\/register-[\w-]+\.ps1$/, `${n} must map to a committed register script`);
    assert.ok(spec.label && spec.label.length > 0, `${n} must have a label`);
  }
});

test("the Gatekeeper (tonight's failure) is auto-repairable, pointing at its committed script", () => {
  assert.ok(isInfraRepairable("SCE-Gatekeeper"));
  const plan = planInfraRepair("SCE-Gatekeeper");
  assert.equal(plan.type, "reregister");
  assert.equal(plan.taskName, "SCE-Gatekeeper");
  assert.equal(plan.script, "windows/register-gatekeeper.ps1");
});

test("task-health is auto-repairable too (so the two monitors can heal each other)", () => {
  assert.ok(isInfraRepairable("SCE-TaskHealth"));
  assert.equal(planInfraRepair("SCE-TaskHealth").type, "reregister");
});

test("a non-infra task is NOT auto-repairable → planInfraRepair returns null", () => {
  assert.equal(isInfraRepairable("BetterLife-WeeklyAutopilot"), false);
  assert.equal(isInfraRepairable("SomeRandomTask"), false);
  assert.equal(planInfraRepair("BetterLife-WeeklyAutopilot"), null);
  assert.equal(planInfraRepair(""), null);
  assert.equal(planInfraRepair(null), null);
});

// ── Retry cap: re-registration is idempotent, so try at most `cap` times per day, then escalate.
// This prevents a blind-repair loop when the failure is a real runtime bug (which re-registering can't fix).
test("shouldAttemptRepair allows the first repair of the day, then blocks once the cap is hit", () => {
  const today = "2026-06-28";
  let state = {};
  assert.equal(shouldAttemptRepair(state, "SCE-Gatekeeper", today, 1), true);   // no attempts yet → allowed
  state = recordRepairAttempt(state, "SCE-Gatekeeper", today);
  assert.equal(shouldAttemptRepair(state, "SCE-Gatekeeper", today, 1), false);  // cap=1 reached → blocked → escalate
});

test("the retry counter resets on a new day", () => {
  let state = recordRepairAttempt({}, "SCE-Gatekeeper", "2026-06-28");
  assert.equal(shouldAttemptRepair(state, "SCE-Gatekeeper", "2026-06-28", 1), false); // capped today
  assert.equal(shouldAttemptRepair(state, "SCE-Gatekeeper", "2026-06-29", 1), true);  // new day → allowed again
});

test("recordRepairAttempt counts within a day and is independent per task", () => {
  let state = {};
  state = recordRepairAttempt(state, "SCE-Gatekeeper", "2026-06-28");
  state = recordRepairAttempt(state, "SCE-Gatekeeper", "2026-06-28");
  assert.equal(state["SCE-Gatekeeper"].attempts, 2);
  assert.equal(state["SCE-Gatekeeper"].date, "2026-06-28");
  // a different task is tracked separately
  assert.equal(shouldAttemptRepair(state, "SCE-TaskHealth", "2026-06-28", 1), true);
});
