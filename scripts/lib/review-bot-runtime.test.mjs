import test from "node:test";
import assert from "node:assert/strict";
import {
  createPollWatchdog,
  describeFetchError,
  REVIEW_LIVENESS_CREDIT_MAX_GAP_MS,
  REVIEW_LIVENESS_MAX_AGE_MS,
  runTelegramReviewBot,
} from "./review-bot-runtime.mjs";
import { TELEGRAM_LONG_POLL_TIMEOUT_MS } from "./telegram-http.mjs";

const inertTimer = { unref() {} };

// ── the 2026-07-31 "loop error: fetch failed" investigation ────────────────────────
// 30 of these appeared in an 8-hour worker window carrying neither a bot name nor a
// cause, so the error could not be classified as transient or structural at all.

test("a poll failure names the bot and unwraps undici's cause chain", async () => {
  const logs = [];
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), { code: "ENOTFOUND" });
  await runTelegramReviewBot({
    name: "TML review bot",
    tg: async () => { throw err; },
    loadOffset: () => 0,
    saveOffset: () => {},
    dispatch: async () => {},
    runSweep: async () => {},
    replyError: async () => {},
    sleep: async () => {},
    log: (line) => logs.push(line),
    maxPolls: 1,
    setIntervalFn: () => inertTimer,
    clearIntervalFn: () => {},
  });

  const line = logs.find((l) => l.includes("loop error"));
  assert.ok(line, `expected a loop error line, got ${JSON.stringify(logs)}`);
  assert.match(line, /^TML review bot loop error #1:/, line);
  assert.match(line, /ENOTFOUND/, line);
  assert.match(line, /api\.telegram\.org/, line);
  // REGRESSION TWIN: the pre-fix line was exactly `loop error: ${error.message}`, which
  // is the literal string "fetch failed" for EVERY undici failure, from any of the four
  // bots. If this line ever reverts, the assertions above go red.
  const preFix = `loop error: ${err.message}`;
  assert.equal(preFix, "loop error: fetch failed");
  assert.ok(!preFix.includes("ENOTFOUND"), "pre-fix line carried no cause");
  assert.ok(!preFix.includes("TML"), "pre-fix line carried no bot name");
});

test("consecutive poll failures are counted, and recovery is stated explicitly", async () => {
  const logs = [];
  let call = 0;
  await runTelegramReviewBot({
    name: "Sunmood review bot",
    tg: async () => {
      call += 1;
      if (call <= 2) throw new TypeError("fetch failed");
      return { ok: true, result: [] };
    },
    loadOffset: () => 0,
    saveOffset: () => {},
    dispatch: async () => {},
    runSweep: async () => {},
    replyError: async () => {},
    sleep: async () => {},
    log: (line) => logs.push(line),
    maxPolls: 3,
    setIntervalFn: () => inertTimer,
    clearIntervalFn: () => {},
  });

  assert.ok(logs.some((l) => l.includes("loop error #1")), JSON.stringify(logs));
  assert.ok(logs.some((l) => l.includes("loop error #2")), JSON.stringify(logs));
  assert.ok(
    logs.some((l) => l === "Sunmood review bot recovered after 2 consecutive poll failure(s)"),
    JSON.stringify(logs),
  );
});

test("describeFetchError survives a cyclic cause chain instead of hanging", () => {
  const a = new Error("outer");
  const b = new Error("inner");
  a.cause = b;
  b.cause = a;
  const described = describeFetchError(a);
  assert.match(described, /outer/);
  assert.match(described, /inner/);
  assert.ok(described.split(" <- ").length <= 5, described);
});

test("describeFetchError reads an aggregate DNS error's first entry", () => {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new AggregateError([Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" })], "all attempts failed"), {});
  assert.match(describeFetchError(err), /ECONNREFUSED/);
});

test("describeFetchError on a real undici failure carries a code, not just 'fetch failed'", async () => {
  // The path that actually fails in production: a genuine Node fetch to a host that
  // cannot resolve. No stub — this proves the shape of the error we are formatting.
  let caught;
  try {
    await fetch("https://this-host-does-not-exist.invalid/x");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected the fetch to reject");
  assert.equal(caught.message, "fetch failed", "undici's message is always this — the reason it was undiagnosable");
  const described = describeFetchError(caught);
  assert.ok(described.length > "fetch failed".length, `described was not richer than the bare message: ${described}`);
  assert.match(described, /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|UND_ERR|getaddrinfo|queryA/i, described);
});

test("a hung sweep reaches its deadline and cannot prevent the next getUpdates", async () => {
  const calls = [];
  const logs = [];
  await runTelegramReviewBot({
    name: "Test review bot",
    tg: async (method, body, options) => {
      calls.push({ method, body, options });
      return { ok: true, result: [] };
    },
    loadOffset: () => 0,
    saveOffset: () => {},
    dispatch: async () => {},
    runSweep: () => new Promise(() => {}),
    replyError: async () => {},
    sleep: async () => {},
    log: (line) => logs.push(line),
    sweepTimeoutMs: 10,
    maxPolls: 2,
    setIntervalFn: () => inertTimer,
    clearIntervalFn: () => {},
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.timeoutMs, TELEGRAM_LONG_POLL_TIMEOUT_MS);
  assert.ok(logs.some((line) => line.startsWith("sweep error: Test review bot sweep exceeded")));
});

test("more than six minutes without an HTTP-ok poll exits one with a named fatal line", () => {
  let nowMs = 1_000;
  const exitCodes = [];
  const fatalLines = [];
  const watchdog = createPollWatchdog({
    name: "TML review bot",
    now: () => nowMs,
    exit: (code) => exitCodes.push(code),
    logFatal: (line) => fatalLines.push(line),
    setIntervalFn: () => inertTimer,
    clearIntervalFn: () => {},
  });

  nowMs += REVIEW_LIVENESS_MAX_AGE_MS + 1;
  assert.equal(watchdog.check(), true);
  assert.deepEqual(exitCodes, [1]);
  assert.match(fatalLines[0], /^TML review bot FATAL: no successful getUpdates/);
  watchdog.stop();
});

test("only an ok getUpdates result refreshes liveness", async () => {
  let nowMs = 0;
  const exitCodes = [];
  let intervalCallback;
  await runTelegramReviewBot({
    name: "Non-ok review bot",
    tg: async () => ({ ok: false, description: "bad response" }),
    loadOffset: () => 0,
    saveOffset: () => {},
    dispatch: async () => {},
    runSweep: async () => {},
    replyError: async () => {},
    now: () => nowMs,
    sleep: async () => {},
    log: () => {},
    logFatal: () => {},
    exit: (code) => exitCodes.push(code),
    maxPolls: 1,
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return inertTimer;
    },
    clearIntervalFn: () => {},
  });
  nowMs = REVIEW_LIVENESS_MAX_AGE_MS + 1;
  intervalCallback();
  assert.deepEqual(exitCodes, [1]);
});

test("sweeps receive no liveness credit until getUpdates is HTTP-ok", async () => {
  const observations = [];
  await runTelegramReviewBot({
    name: "Observed review bot",
    tg: async () => ({ ok: false, description: "fake failure" }),
    loadOffset: () => 0,
    saveOffset: () => {},
    dispatch: async () => {},
    runSweep: async (_now, _signal, liveness) => observations.push(liveness),
    replyError: async () => {},
    now: () => 1234,
    sleep: async () => {},
    log: () => {},
    maxPolls: 1,
    setIntervalFn: () => inertTimer,
    clearIntervalFn: () => {},
  });
  assert.equal(observations[0].observedAtMs, null);
  assert.equal(observations[0].maxGapMs, REVIEW_LIVENESS_CREDIT_MAX_GAP_MS);
});
