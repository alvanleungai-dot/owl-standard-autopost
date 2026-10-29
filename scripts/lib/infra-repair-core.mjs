// scripts/lib/infra-repair-core.mjs — PURE logic for INFRASTRUCTURE self-repair. No I/O.
//
// THE GAP THIS CLOSES (2026-06-28). SCE-Gatekeeper was registered with a mis-quoted action → node never
// ran → exit 0x1 with an empty log → SCE-TaskHealth fired a daily Telegram "task failed" alert and the
// OWNER had to come fix it by hand. The Gatekeeper's own self-heal layer couldn't help — it lives INSIDE
// the Gatekeeper, the very thing that wasn't running. But task-health DID keep running and DID catch it;
// it just wasn't allowed to FIX it, only to alert.
//
// This module is that missing permission, kept deliberately narrow per the owner's decision
// ("auto-fix infrastructure only"): an always-on monitor may RE-REGISTER a broken monitor/infra task from
// its OWN committed register-*.ps1 script. That is deterministic, idempotent, reversible, and touches NO
// posts, NO accounts, NO money. Anything outside this closed registry still escalates to the owner exactly
// as before.
//
// SAFETY HEART: the registry below is the entire boundary of what may be auto-repaired. It must contain
// ONLY monitor/infra tasks that have a committed register script. A posting / generation / browser task
// must NEVER appear here (enforced by infra-repair-core.test.mjs). Pure → fully unit-testable.

// task name → { script (committed, repo-relative), label }. To make another infra task auto-repairable,
// add a committed windows/register-<task>.ps1 and a one-line entry here — nothing else changes.
export const INFRA_REPAIR_REGISTRY = {
  "SCE-Gatekeeper": { script: "windows/register-gatekeeper.ps1", label: "守門人 SCE-Gatekeeper" },
  "SCE-TaskHealth": { script: "windows/register-task-health.ps1", label: "任務健康監察 SCE-TaskHealth" },
};

export function isInfraRepairable(taskName) {
  return Object.prototype.hasOwnProperty.call(INFRA_REPAIR_REGISTRY, String(taskName || ""));
}

// Build the deterministic repair PLAN, or null for anything not in the registry (the safe default: escalate).
// Data only — it is the runner (in task-health.mjs / gatekeeper.mjs) that actually executes the committed
// script, and ONLY this one shape exists: re-register the task from its own committed register-*.ps1.
export function planInfraRepair(taskName) {
  const spec = INFRA_REPAIR_REGISTRY[String(taskName || "")];
  if (!spec) return null;
  return { type: "reregister", taskName, script: spec.script, label: spec.label };
}

// ── Retry cap (pure) ────────────────────────────────────────────────────────────────────────────────
// Re-registration is idempotent: if one re-register doesn't heal the task, repeating it won't either —
// the failure is then a real runtime bug that needs the owner. So a task may be auto-repaired at most
// `cap` times per calendar day; after that, escalate. state shape: { [taskName]: { date, attempts } }.
export function shouldAttemptRepair(state, taskName, today, cap = 1) {
  const e = (state || {})[taskName];
  const attemptsToday = e && e.date === today ? (e.attempts || 0) : 0;
  return attemptsToday < cap;
}

export function recordRepairAttempt(state, taskName, today) {
  const prev = (state || {})[taskName];
  const attempts = prev && prev.date === today ? (prev.attempts || 0) + 1 : 1;
  return { ...(state || {}), [taskName]: { date: today, attempts } };
}

// ── Verify a re-register WORKED (pure) ────────────────────────────────────────────────────────────────
// Verification is "is the task now registered correctly?", NOT "run it and watch the exit code." Running
// the task and polling LastTaskResult was fragile: a slow-but-successful run timed out → false failure, and
// an empty/garbled read parsed to 0x0 → false "healed". Re-registering from the committed script is the
// repair; success = the task is present, enabled, and its action carries the CORRECT outer-quoting (the
// 2026-06-28 bug was a mis-quoted action). The next scheduled run + the monitor confirm runtime health.

// True if a cmd.exe `/c "<...>"` action is correctly OUTER-quoted (`/c ""...`). The broken collapse is
// `/c "<path-with-space>...`. N/A (→ true) for any action that isn't a cmd `/c` wrapper, so a non-cmd infra
// task is never failed spuriously. Our register-*.ps1 scripts all emit the `/c ""...` form.
export function looksCorrectlyQuoted(actionArgs) {
  const a = String(actionArgs || "");
  if (!/^\s*\/c\s/i.test(a)) return true;   // not a cmd /c wrapper → can't judge quoting → N/A
  return /^\s*\/c\s+""/i.test(a);
}

// Judge a re-register from the post-repair task snapshot. snapshot: { present, state, actionArgs }.
// Returns { ok, reason }. ok ⇒ the repair took effect; !ok ⇒ caller escalates with `reason`.
export function verifyReregister(snapshot = {}) {
  const { present, state, actionArgs } = snapshot;
  if (!present) return { ok: false, reason: "task not present after re-register" };
  if (String(state || "").toLowerCase() === "disabled") return { ok: false, reason: "task disabled after re-register" };
  if (!looksCorrectlyQuoted(actionArgs)) return { ok: false, reason: "action still mis-quoted after re-register" };
  return { ok: true, reason: "re-registered correctly (present, enabled, well-quoted)" };
}
