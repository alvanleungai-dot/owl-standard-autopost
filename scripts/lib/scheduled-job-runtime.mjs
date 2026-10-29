import { isIdempotentNoopExit } from "./process-outcome.mjs";
import { killProcessTree } from "./process-tree-kill.mjs";

export const JOB_KILL_GRACE_MS = 10_000;
// Exit code 2 is the monitors' "found problems AND already escalated them" signal (preflight,
// repair). Their own alert already went out through the same ops channel, so a second generic
// "job exited with code 2" message would only say the same thing twice.
export const REPORTED_ISSUES_EXIT_CODE = 2;

export function createScheduledJobSupervisor({
  spawnChild,
  alert,
  resolveAlert = () => {},
  log = console.log,
  logError = console.error,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  killGraceMs = JOB_KILL_GRACE_MS,
  // Kills the WHOLE process tree rooted at the job, not just the direct child —
  // see scripts/lib/process-tree-kill.mjs. Injectable so tests never have to
  // exercise real OS process-group/taskkill behaviour against fake pids.
  killTree = killProcessTree,
} = {}) {
  if (typeof spawnChild !== "function" || typeof alert !== "function") {
    throw new TypeError("scheduled job supervisor requires spawnChild and alert functions");
  }
  const running = new Map();

  function start(item, { onExit } = {}) {
    if (!Number.isFinite(item?.maxRuntimeMs) || item.maxRuntimeMs <= 0) {
      throw new TypeError(`scheduled job ${item?.name || "(unnamed)"} requires a positive maxRuntimeMs`);
    }
    const child = spawnChild(item);
    const record = {
      child,
      maxTimer: null,
      forceTimer: null,
      timedOut: false,
      stopping: false,
    };
    running.set(item.name, record);
    log(`worker: started ${item.name} pid=${child.pid}`);

    child.on("error", (error) => logError(`worker: ${item.name} spawn error: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (record.maxTimer) clearTimeoutFn(record.maxTimer);
      if (record.forceTimer) clearTimeoutFn(record.forceTimer);
      if (running.get(item.name) === record) running.delete(item.name);
      log(`worker: ${item.name} exited code=${code ?? "null"} signal=${signal ?? "none"}`);
      const failureKind = `job-failed:${item.name}`;
      const idempotentNoop = isIdempotentNoopExit(code);
      if ((code === 0 || idempotentNoop) && !record.timedOut && !record.stopping) {
        resolveAlert("render-worker", failureKind);
        if (idempotentNoop) log(`worker: ${item.name} completed as idempotent no-op`);
      } else if (code === REPORTED_ISSUES_EXIT_CODE && !record.timedOut && !record.stopping) {
        log(`worker: ${item.name} reported issues (exit 2); its own alert already went out`);
      } else if (code !== null && code !== 0 && !record.timedOut && !record.stopping) {
        Promise.resolve(alert({
          source: "render-worker",
          kind: failureKind,
          severity: "crucial",
          text: `Render worker job ${item.name} exited with code ${code}.`,
        })).then((delivered) => {
          if (!delivered) {
            logError(
              `worker: ALERT_DELIVERY_FAILED job=${item.name} event=JOB_FAILED exitCode=${code}`,
            );
          }
        }, (error) => {
          logError(
            `worker: ALERT_DELIVERY_FAILED job=${item.name} event=JOB_FAILED ` +
            `exitCode=${code} error=${error?.message || error}`,
          );
        });
      }
      if (typeof onExit === "function") {
        try {
          onExit({
            code,
            signal,
            timedOut: record.timedOut,
            stopping: record.stopping,
            idempotentNoop,
          });
        } catch (error) {
          logError(`worker: ${item.name} exit observer error: ${error?.message || error}`);
        }
      }
    });

    record.maxTimer = setTimeoutFn(() => {
      if (running.get(item.name) !== record) return;
      record.timedOut = true;
      logError(
        `worker: JOB_MAX_RUNTIME_EXCEEDED job=${item.name} pid=${child.pid} ` +
        `maxRuntimeMs=${item.maxRuntimeMs}; sending SIGTERM to the whole process tree`,
      );
      killTree(child, "SIGTERM");
      Promise.resolve(alert({
        source: "render-worker",
        kind: `job-max-runtime:${item.name}`,
        severity: "crucial",
        text: `Render worker killed ${item.name} after it exceeded its ${item.maxRuntimeMs}ms maximum runtime.`,
      })).then((delivered) => {
        if (!delivered) {
          logError(`worker: ALERT_DELIVERY_FAILED job=${item.name} event=JOB_MAX_RUNTIME_EXCEEDED`);
        }
      }, (error) => {
        logError(
          `worker: ALERT_DELIVERY_FAILED job=${item.name} event=JOB_MAX_RUNTIME_EXCEEDED ` +
          `error=${error?.message || error}`,
        );
      });

      record.forceTimer = setTimeoutFn(() => {
        if (running.get(item.name) !== record) return;
        logError(`worker: JOB_FORCE_KILL job=${item.name} pid=${child.pid}; sending SIGKILL to the whole process tree`);
        killTree(child, "SIGKILL");
      }, killGraceMs);
      record.forceTimer?.unref?.();
    }, item.maxRuntimeMs);
    record.maxTimer?.unref?.();
    return child;
  }

  function stopAll(signal = "SIGTERM") {
    for (const record of running.values()) {
      record.stopping = true;
      if (record.maxTimer) clearTimeoutFn(record.maxTimer);
      if (record.forceTimer) clearTimeoutFn(record.forceTimer);
      killTree(record.child, signal);
    }
  }

  return {
    start,
    stopAll,
    has: (name) => running.has(name),
    running,
  };
}
