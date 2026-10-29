import test from "node:test";
import assert from "node:assert/strict";
import { telegramRequest } from "./telegram-http.mjs";

test("a Telegram call rejects when its fake fetch transport never resolves", async () => {
  await assert.rejects(
    telegramRequest({
      token: "fake-token",
      method: "sendMessage",
      body: { chat_id: "fake-chat", text: "test" },
      timeoutMs: 20,
      fetchImpl: () => new Promise(() => {}),
    }),
    (error) => error.kind === "deadline" && /Telegram sendMessage/.test(error.message),
  );
});

test("Telegram transport forwards a live abort signal to fetch", async () => {
  let observedSignal;
  const result = await telegramRequest({
    token: "fake-token",
    method: "getUpdates",
    body: { timeout: 50 },
    timeoutMs: 65_000,
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    },
  });
  assert.equal(observedSignal instanceof AbortSignal, true);
  assert.equal(observedSignal.aborted, false);
  assert.deepEqual(result, { ok: true, result: [] });
});

test("an HTTP-ok Telegram API error still throws for the bot loop to log", async () => {
  await assert.rejects(
    telegramRequest({
      token: "fake-token",
      method: "sendMessage",
      body: { chat_id: "fake-chat", text: "test" },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ ok: false, description: "chat not found" }),
      }),
    }),
    /Telegram sendMessage API error: chat not found/,
  );
});

test("a fake Telegram HTTP 401 is rejected before any success is reported", async () => {
  await assert.rejects(
    telegramRequest({
      token: "invalid-token",
      method: "sendMessage",
      body: { chat_id: "fake-chat", text: "test" },
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, description: "Unauthorized" }),
      }),
    }),
    /Telegram sendMessage HTTP 401: Unauthorized/,
  );
});

test("an empty sendMessage is refused before the fake Telegram transport is reached", async () => {
  let transportCalls = 0;
  await assert.rejects(
    telegramRequest({
      token: "fake-token",
      method: "sendMessage",
      body: { chat_id: "fake-chat", text: " \n\t " },
      fetchImpl: async () => {
        transportCalls += 1;
        return { ok: true, json: async () => ({ ok: true }) };
      },
    }),
    /Telegram sendMessage text must be non-empty/,
  );
  assert.equal(transportCalls, 0);
});

test("a Telegram HTTP error includes the API description from the response body", async () => {
  await assert.rejects(
    telegramRequest({
      token: "fake-token",
      method: "sendMessage",
      body: { chat_id: "fake-chat", text: "failure report" },
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
      }),
    }),
    /Telegram sendMessage HTTP 400: Bad Request: chat not found/,
  );
});
