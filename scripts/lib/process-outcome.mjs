export const IDEMPOTENT_NOOP_EXIT_CODE = 75;

export function processExitCode(error) {
  for (const value of [error?.exitCode, error?.status, error?.code]) {
    const code = Number(value);
    if (Number.isInteger(code)) return code;
  }
  return null;
}

export function isIdempotentNoopExit(errorOrCode) {
  if (typeof errorOrCode === "number" || typeof errorOrCode === "string") {
    return Number(errorOrCode) === IDEMPOTENT_NOOP_EXIT_CODE;
  }
  return processExitCode(errorOrCode) === IDEMPOTENT_NOOP_EXIT_CODE;
}
