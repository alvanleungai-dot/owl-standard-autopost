// scripts/lib/task-health-core.mjs — pure logic for the scheduled-task health monitor. No I/O.
// Watches the Windows Task Scheduler LastTaskResult of our automation tasks so a CRASHED task
// (e.g. AutoSchedule exiting 0x1) is caught immediately. This closes the gap that hid the
// 2026-06-22 incident: both AutoSchedule tasks failed silently (0x1) and only the reactive
// watchdog noticed posts were missing, days later. Tested in task-health-core.test.mjs.

// Windows Task Scheduler LastTaskResult codes that are NOT a failure (never alert on these):
export const BENIGN_RESULTS = new Set([
  0x0,      // success
  0x41301,  // 267009 — task is currently running
  0x41303,  // 267011 — task has not yet run
]);

export const toHex = (code) => "0x" + ((code >>> 0).toString(16).toUpperCase());

// MONITOR tasks (task-health / watchdog / preflight / catchup / gatekeeper) exit code 2 BY DESIGN to
// SIGNAL "I found + escalated issues" — that's the monitor WORKING, not broken. For these — and ONLY these
// — 0x2 is benign. For every OTHER task (generation, posting) exit 2 IS a real failure we MUST surface:
// e.g. gen-week.mjs / post-today.mjs exit 2 when posters/posts fail, precisely so this monitor catches
// the silent-failure class that hid the 2026-06-22 incident. So we must NOT make 0x2 benign globally.
// Mirrors the same convention in gatekeeper-core.mjs (triageTask).
export const MONITOR_TASK_RE = /gatekeeper|task-?health|watchdog|preflight|catchup/i;
const isBenignResult = (name, lastResult) => {
  const code = lastResult >>> 0;
  if (BENIGN_RESULTS.has(code)) return true;
  return code === 0x2 && MONITOR_TASK_RE.test(String(name)); // monitor "found + escalated" — not a crash
};

// rows: [{ name, state, lastResult }] (lastResult = uint from Task Scheduler).
// watch: case-insensitive substrings identifying our automation tasks.
// Returns the unhealthy ones: watched, enabled, with a non-benign LastTaskResult.
export function unhealthyTasks(rows, watch) {
  const isWatched = (n) => (watch || []).some((w) => String(n).toLowerCase().includes(String(w).toLowerCase()));
  return (rows || [])
    .filter((r) => r && r.name && isWatched(r.name))
    .filter((r) => String(r.state).toLowerCase() !== "disabled")
    .filter((r) => !isBenignResult(r.name, r.lastResult))
    .map((r) => ({ name: r.name, lastResult: r.lastResult >>> 0, hex: toHex(r.lastResult) }));
}
