import { DEFAULT_HTTP_TIMEOUT_MS, withDeadline } from "./http-deadline.mjs";

export const TELEGRAM_REQUEST_TIMEOUT_MS = DEFAULT_HTTP_TIMEOUT_MS;
export const TELEGRAM_LONG_POLL_TIMEOUT_MS = 65_000;

export async function telegramRequest({
  token,
  method,
  body,
  timeoutMs = TELEGRAM_REQUEST_TIMEOUT_MS,
  signal,
  fetchImpl = globalThis.fetch,
  form = false,
}) {
  if (!token) throw new Error("Telegram bot token is required");
  if (!method) throw new Error("Telegram Bot API method is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  if (
    method === "sendMessage" &&
    (!body || typeof body.text !== "string" || body.text.trim().length === 0)
  ) {
    throw new Error("Telegram sendMessage text must be non-empty");
  }

  return withDeadline(async (deadlineSignal) => {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: form ? undefined : { "Content-Type": "application/json" },
      body: form ? body : JSON.stringify(body),
      signal: deadlineSignal,
    });
    let payload;
    let payloadError;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
      payloadError = error;
    }
    if (response?.ok === false) {
      const reason = payload?.description ? `: ${payload.description}` : "";
      throw new Error(`Telegram ${method} HTTP ${response.status}${reason}`);
    }
    if (payloadError) {
      throw new Error(`Telegram ${method} returned invalid JSON: ${payloadError.message}`);
    }
    if (payload?.ok === false) {
      throw new Error(`Telegram ${method} API error: ${payload.description || "unknown error"}`);
    }
    return payload;
  }, {
    timeoutMs,
    signal,
    label: `Telegram ${method}`,
  });
}
