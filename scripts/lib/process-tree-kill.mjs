// scripts/lib/process-tree-kill.mjs — kill a scheduled job's WHOLE process tree,
// not just the direct child.
//
// Why this exists (2026-07-31 adversarial review, DEFECT 1): a scheduled job can
// itself synchronously spawn a grandchild — Golf-Notion-Feedback
// (scripts/golf/watch-feedback.mjs) shells out to build-batch.mjs via
// execFileSync() while it waits for a paid gpt-image-2 render. If the supervisor's
// maxRuntimeMs timeout fires while the watcher is blocked inside that
// execFileSync call, killing only the direct child (the watcher) does NOT kill
// build-batch.mjs: SIGKILLing a process does not propagate to its own children —
// the OS reparents them (to init/PID 1 on Linux) and they keep running. The
// grandchild can then keep consuming the paid image request after the job that
// "owns" it has been reaped, and can still write its render to durable batch
// output later, after the row it belongs to has already been recovered as
// stranded. A comment that used to sit next to the job's maxRuntimeMs claimed
// this "can never double-spend" — that claim was FALSE; this module is the fix.
//
// POSIX (this worker runs on Render/Linux): scripts/render-worker.mjs spawns
// every job with `detached: true`, which makes the job the LEADER of a new
// process group whose pgid equals its own pid. Every process that job spawns
// synchronously (execFileSync, spawnSync, spawn without its own `detached`)
// inherits that same process group. Signalling the NEGATIVE pid delivers the
// signal to every member of that group at once — the job, its grandchild, and
// anything the grandchild itself spawned (e.g. Playwright's own Chromium
// process), in one syscall.
//
// Windows has no process-group signal Node can use, and child.kill() there
// already collapses every signal to an immediate hard termination of just the
// one process. `taskkill /T` is the documented way to reach a Windows process
// tree, so it is used unconditionally on that platform (there is no softer
// "SIGTERM-then-SIGKILL" distinction to preserve there anyway).
import { execFileSync as nodeExecFileSync } from "node:child_process";

/**
 * @param {{ pid?: number, kill: (signal: string) => unknown }} child
 * @param {string} signal
 * @param {{
 *   platform?: string,
 *   execFileSyncFn?: typeof nodeExecFileSync,
 *   killGroup?: (pid: number, signal: string) => unknown,
 * }} [deps] injection seam for tests — production code relies on the defaults.
 * @returns {boolean} true if the tree-level mechanism was used, false if the
 *   direct-child fallback was needed (already-gone process, unreadable pid, or a
 *   platform primitive that failed).
 */
export function killProcessTree(child, signal, {
  platform = process.platform,
  execFileSyncFn = nodeExecFileSync,
  killGroup = (pid, sig) => process.kill(-pid, sig),
} = {}) {
  if (!child || !Number.isInteger(child.pid)) return false;

  if (platform === "win32") {
    try {
      // /T = kill the whole tree rooted at this pid. /F = force; there is no
      // graceful Windows equivalent of SIGTERM for an arbitrary process tree, so
      // both the "advisory" and "force" phases in scheduled-job-runtime.mjs
      // resolve to the same hard kill here.
      execFileSyncFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return true;
    } catch {
      // Already exited, or taskkill itself is unavailable. Fall back to the
      // direct child so at least that one process is still targeted.
      try { child.kill(signal); } catch { /* already gone */ }
      return false;
    }
  }

  try {
    killGroup(child.pid, signal);
    return true;
  } catch {
    // ESRCH (group already gone) or a pgid surprise (the child was somehow not
    // its own group leader). Fall back to the direct child so a platform
    // surprise never leaves the job entirely un-killed.
    try { child.kill(signal); } catch { /* already gone */ }
    return false;
  }
}
