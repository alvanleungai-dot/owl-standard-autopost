export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const PUBLISH_HTTP_TIMEOUT_MS = 60_000;
export const MEDIA_HTTP_TIMEOUT_MS = 2 * 60_000;
export const AI_TEXT_HTTP_TIMEOUT_MS = 2 * 60_000;
export const AI_IMAGE_HTTP_TIMEOUT_MS = 5 * 60_000;

export class DeadlineError extends Error {
  constructor(label, timeoutMs, cause) {
    super(`${label} exceeded its ${timeoutMs}ms deadline`);
    this.name = "DeadlineError";
    this.kind = "deadline";
    this.cause = cause;
  }
}

export function withDeadline(operation, {
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  signal,
  label = "operation",
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("deadline timeoutMs must be a positive finite number");
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const deadlineSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      deadlineSignal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(
      reject,
      new DeadlineError(label, timeoutMs, deadlineSignal.reason),
    );

    if (deadlineSignal.aborted) {
      onAbort();
      return;
    }
    deadlineSignal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => operation(deadlineSignal))
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export function fetchWithDeadline(url, options = {}, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  signal = options.signal,
  label = `fetch ${url}`,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  return withDeadline(
    (deadlineSignal) => fetchImpl(url, { ...options, signal: deadlineSignal }),
    { timeoutMs, signal, label },
  );
}
