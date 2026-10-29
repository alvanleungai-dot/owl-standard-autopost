import { withDeadline } from "./http-deadline.mjs";
import { TELEGRAM_LONG_POLL_TIMEOUT_MS } from "./telegram-http.mjs";

export const REVIEW_POLL_RETRY_MS = 3_000;
export const REVIEW_SWEEP_TIMEOUT_MS = 60_000;
export const REVIEW_LIVENESS_MAX_AGE_MS = 6 * 60 * 1000;
export const REVIEW_LIVENESS_CREDIT_MAX_GAP_MS =
  TELEGRAM_LONG_POLL_TIMEOUT_MS + REVIEW_POLL_RETRY_MS + 5_000;
export const REVIEW_WATCHDOG_INTERVAL_MS = 30_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Render a thrown poll error so the log line can actually be diagnosed.
 *
 * WHY (2026-07-31). The worker logged `loop error: fetch failed` 30 times in an 8-hour
 * window and the line was useless twice over. First, `undici` — Node's built-in fetch —
 * throws a generic TypeError whose message is ALWAYS the literal string "fetch failed";
 * the real reason (ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT, a TLS failure) lives
 * only on `error.cause`, which this line discarded. Second, all four review bots
 * (Bright Day, Sunmood, Better Life, TML) call console.log with no prefix, so 30
 * identical anonymous lines could not even be attributed to a bot.
 *
 * The result was an error nobody could classify as transient or structural, which is
 * exactly how it sat "recurring, unverified" for days. Same law as everywhere else here:
 * a report must be triageable from its own text.
 *
 * Walks the cause chain (undici nests, and an aggregate DNS error carries `.errors`)
 * with a depth cap, because a cyclic or deeply-wrapped cause must not hang the logger.
 */
export function describeFetchError(error, maxDepth = 4) {
  const parts = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth <= maxDepth; depth++) {
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    const code = current?.code ? ` (${current.code})` : "";
    const message = String(current?.message ?? current);
    parts.push(`${message}${code}`);
    const nested = current?.cause ?? (Array.isArray(current?.errors) ? current.errors[0] : undefined);
    if (!nested) break;
    current = nested;
  }
  // Collapse undici's "fetch failed" -> "fetch failed" repeats; keep the informative tail.
  const deduped = parts.filter((p, i) => i === 0 || p !== parts[i - 1]);
  return deduped.join(" <- ");
}

export function createPollWatchdog({
  name,
  now = Date.now,
  logFatal = console.error,
  exit = (code) => process.exit(code),
  maxAgeMs = REVIEW_LIVENESS_MAX_AGE_MS,
  intervalMs = REVIEW_WATCHDOG_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!name) throw new TypeError("review bot watchdog name is required");
  const startedAtMs = now();
  let lastSuccessfulPollMs = null;
  let fatal = false;

  const check = () => {
    const ageMs = now() - (lastSuccessfulPollMs ?? startedAtMs);
    if (!fatal && ageMs > maxAgeMs) {
      fatal = true;
      logFatal(`${name} FATAL: no successful getUpdates for ${ageMs}ms; exiting for supervisor restart`);
      exit(1);
      return true;
    }
    return false;
  };
  const timer = setIntervalFn(check, intervalMs);
  timer?.unref?.();

  return {
    markSuccessfulPoll(atMs = now()) {
      lastSuccessfulPollMs = atMs;
    },
    check,
    lastSuccessfulPollMs: () => lastSuccessfulPollMs,
    stop() {
      clearIntervalFn(timer);
    },
  };
}

export async function runTelegramReviewBot({
  name,
  tg,
  loadOffset,
  saveOffset,
  dispatch,
  runSweep,
  replyError,
  now = Date.now,
  sleep = defaultSleep,
  log = console.log,
  logFatal = console.error,
  exit = (code) => process.exit(code),
  pollTimeoutMs = TELEGRAM_LONG_POLL_TIMEOUT_MS,
  retryMs = REVIEW_POLL_RETRY_MS,
  sweepTimeoutMs = REVIEW_SWEEP_TIMEOUT_MS,
  livenessMaxAgeMs = REVIEW_LIVENESS_MAX_AGE_MS,
  livenessCreditMaxGapMs = REVIEW_LIVENESS_CREDIT_MAX_GAP_MS,
  watchdogIntervalMs = REVIEW_WATCHDOG_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  maxPolls = Infinity,
} = {}) {
  if (!name || typeof tg !== "function") throw new TypeError("review bot name and tg function are required");
  let offset = loadOffset();
  let polls = 0;
  let consecutivePollFailures = 0;
  const watchdog = createPollWatchdog({
    name,
    now,
    logFatal,
    exit,
    maxAgeMs: livenessMaxAgeMs,
    intervalMs: watchdogIntervalMs,
    setIntervalFn,
    clearIntervalFn,
  });

  try {
    while (polls < maxPolls) {
      try {
        const response = await tg("getUpdates", {
          offset: offset + 1,
          timeout: 50,
          allowed_updates: ["message", "callback_query"],
        }, { timeoutMs: pollTimeoutMs });
        polls += 1;
        if (response.ok) {
          if (consecutivePollFailures) {
            log(`${name} recovered after ${consecutivePollFailures} consecutive poll failure(s)`);
            consecutivePollFailures = 0;
          }
          watchdog.markSuccessfulPoll();
          for (const update of response.result || []) {
            offset = Math.max(offset, update.update_id);
            try {
              await dispatch(update);
            } catch (error) {
              try { await replyError(error); } catch {}
            }
          }
          saveOffset(offset);
        } else {
          log(`getUpdates not ok: ${JSON.stringify(response).slice(0, 200)}`);
          await sleep(retryMs);
        }
      } catch (error) {
        polls += 1;
        consecutivePollFailures += 1;
        // Named + caused: see describeFetchError above. The consecutive counter is what
        // separates "one dropped connection" from "this bot has been down for minutes"
        // WITHOUT waiting for the 6-minute watchdog to kill the process — a run of 30
        // isolated singles and a run of 30 in a row read identically otherwise.
        log(`${name} loop error #${consecutivePollFailures}: ${describeFetchError(error)}`);
        await sleep(retryMs);
      }

      try {
        await withDeadline(
          (signal) => runSweep(now(), signal, {
            observedAtMs: watchdog.lastSuccessfulPollMs(),
            maxGapMs: livenessCreditMaxGapMs,
          }),
          { timeoutMs: sweepTimeoutMs, label: `${name} sweep` },
        );
      } catch (error) {
        log(`sweep error: ${error.message}`);
      }
    }
  } finally {
    watchdog.stop();
  }
}
