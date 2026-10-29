export const LONG_LIVED_RESTART_DELAYS_MS = Object.freeze([5_000, 15_000, 60_000]);
export const LONG_LIVED_MAX_CONSECUTIVE_RESTARTS = 5;
export const LONG_LIVED_STABLE_AFTER_MS = 10 * 60 * 1000;

export function createLongLivedSupervisor({
  spawnChild,
  enabled,
  alert,
  isStopping,
  log = console.log,
  logError = console.error,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  now = Date.now,
  restartDelaysMs = LONG_LIVED_RESTART_DELAYS_MS,
  maxConsecutiveRestarts = LONG_LIVED_MAX_CONSECUTIVE_RESTARTS,
  stableAfterMs = LONG_LIVED_STABLE_AFTER_MS,
} = {}) {
  if (typeof spawnChild !== "function") throw new TypeError("spawnChild is required");
  const children = new Map();
  const states = new Map();
  const timers = new Set();

  const start = (item) => {
    const child = spawnChild(item);
    const startedAt = now();
    children.set(item.name, child);
    log(`worker: started ${item.name} pid=${child.pid}`);
    child.on("error", (error) => logError(`worker: ${item.name} spawn error: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (children.get(item.name) === child) children.delete(item.name);
      log(`worker: ${item.name} exited code=${code ?? "null"} signal=${signal ?? "none"}`);
      if (isStopping?.() || !enabled(item)) return;

      const state = states.get(item.name) || { consecutiveRestarts: 0 };
      if (now() - startedAt >= stableAfterMs) state.consecutiveRestarts = 0;
      if (state.consecutiveRestarts >= maxConsecutiveRestarts) {
        const message =
          `worker: ${item.name} FATAL restart cap hit after ` +
          `${state.consecutiveRestarts} consecutive restarts`;
        logError(message);
        Promise.resolve(alert?.({
          source: "render-worker",
          kind: `review-bot-crash-loop-${item.env}`,
          text: `${message}. Manual intervention required.`,
        })).then((delivered) => {
          if (!delivered) {
            logError(`worker: ALERT_DELIVERY_FAILED job=${item.name} event=REVIEW_BOT_CRASH_LOOP`);
          }
        }, (error) => logError(`worker: crash-loop alert failed: ${error.message}`));
        states.set(item.name, state);
        return;
      }

      const attempt = state.consecutiveRestarts + 1;
      const delay = restartDelaysMs[Math.min(attempt - 1, restartDelaysMs.length - 1)];
      state.consecutiveRestarts = attempt;
      states.set(item.name, state);
      log(
        `worker: restart scheduled ${item.name} delay=${delay}ms ` +
        `attempt=${attempt}/${maxConsecutiveRestarts}`,
      );
      let timer;
      timer = schedule(() => {
        timers.delete(timer);
        if (!isStopping?.() && enabled(item)) start(item);
      }, delay);
      timers.add(timer);
      timer?.unref?.();
    });
    return child;
  };

  return {
    children,
    start,
    stopAll(signal = "SIGTERM") {
      for (const timer of timers) cancelSchedule(timer);
      timers.clear();
      for (const child of children.values()) child.kill(signal);
      children.clear();
    },
  };
}
