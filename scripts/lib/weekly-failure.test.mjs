import test from "node:test";
import assert from "node:assert/strict";
import { reportWeeklyError, reportWeeklyFailure } from "./weekly-failure.mjs";
import { IDEMPOTENT_NOOP_EXIT_CODE } from "./process-outcome.mjs";

test("a failed brand-channel error report escalates instead of vanishing", async () => {
  const escalations = [];
  const delivered = await reportWeeklyFailure({
    brand: "sunmood",
    message: "fixed failure report",
    notify: async () => false,
    escalateAlert: async (issue) => { escalations.push(issue); return true; },
  });

  assert.equal(delivered, false);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].kind, "error-report-failed:sunmood");
  assert.match(escalations[0].text, /brand review-channel error report also failed/);
});

test("a delivered brand-channel error report does not create a second alarm", async () => {
  let escalations = 0;
  const delivered = await reportWeeklyFailure({
    brand: "tml",
    message: "fixed failure report",
    notify: async () => true,
    escalateAlert: async () => { escalations += 1; return true; },
  });

  assert.equal(delivered, true);
  assert.equal(escalations, 0);
});

test("an idempotent child outcome is propagated without any failure report or alarm", async () => {
  let notifications = 0;
  let escalations = 0;
  const logs = [];
  const exitCode = await reportWeeklyError({
    brand: "bright-day",
    error: { code: IDEMPOTENT_NOOP_EXIT_CODE },
    message: "must not be sent",
    notify: async () => { notifications += 1; return false; },
    escalateAlert: async () => { escalations += 1; return true; },
    log: (line) => logs.push(line),
  });

  assert.equal(exitCode, IDEMPOTENT_NOOP_EXIT_CODE);
  assert.equal(notifications, 0);
  assert.equal(escalations, 0);
  assert.match(logs.join("\n"), /IDEMPOTENT_NOOP/);
});

test("a real weekly fault still returns non-zero and alarms when its error report fails", async () => {
  const escalations = [];
  const exitCode = await reportWeeklyError({
    brand: "sunmood",
    error: { code: 2, message: "real generator crash" },
    message: "real generator crash",
    notify: async () => false,
    escalateAlert: async (issue) => { escalations.push(issue); return true; },
    log: () => {},
  });

  assert.equal(exitCode, 1);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].severity, "crucial");
});
