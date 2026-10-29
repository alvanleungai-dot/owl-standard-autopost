import { escalate } from "./alert.mjs";
import {
  IDEMPOTENT_NOOP_EXIT_CODE,
  isIdempotentNoopExit,
} from "./process-outcome.mjs";

function errorDetail(error) {
  const detail = String(error?.message || error || "unknown error").trim();
  return (detail || "unknown error").slice(0, 400);
}

export async function reportWeeklyFailure({
  brand,
  message,
  notify,
  escalateAlert = escalate,
}) {
  let delivered = false;
  try {
    delivered = !!(await notify(message));
  } catch {
    delivered = false;
  }
  if (delivered) return true;

  await escalateAlert({
    source: "weekly-run",
    kind: `error-report-failed:${brand}`,
    severity: "crucial",
    text:
      `Weekly generator failed for ${brand}, and its brand review-channel error report also failed to send.\n` +
      errorDetail(message),
  });
  return false;
}

export async function reportWeeklyError({
  brand,
  error,
  message,
  notify,
  escalateAlert = escalate,
  log = console.log,
}) {
  if (isIdempotentNoopExit(error)) {
    log(`IDEMPOTENT_NOOP brand=${brand} reason=artifacts_already_exist`);
    return IDEMPOTENT_NOOP_EXIT_CODE;
  }
  await reportWeeklyFailure({ brand, message, notify, escalateAlert });
  return 1;
}
