import test from "node:test";
import assert from "node:assert/strict";
import { createEscalator, createOpsTelegramSender } from "./alert.mjs";

function memoryHarness(deliver) {
  let state = {};
  const lines = [];
  const escalate = createEscalator({
    loadState: () => structuredClone(state),
    persistState: (next) => { state = structuredClone(next); },
    deliver,
    log: (line) => lines.push(line),
    now: () => 1_000_000_000_000,
  });
  return { escalate, lines, state: () => state };
}

test("failed owner delivery returns false, logs loudly, and remains retryable", async () => {
  let attempts = 0;
  const h = memoryHarness(async () => { attempts += 1; return false; });
  const issue = { source: "worker", kind: "hung-job", text: "test alarm" };

  assert.equal(await h.escalate(issue), false);
  assert.equal(await h.escalate(issue), false);
  assert.equal(attempts, 2, "a failed delivery must not enter the sent cooldown");
  assert.equal(h.state()["worker:hung-job"], undefined);
  assert.equal(h.lines.some((line) => line.includes("SENT to owner")), false);
  assert.equal(
    h.lines.filter((line) => line.startsWith("ALERT_DELIVERY_FAILED alert[worker:hung-job]")).length,
    2,
  );
});

test("a thrown alert transport never crashes the caller and is reported as failed", async () => {
  const h = memoryHarness(async () => { throw new Error("fake transport down"); });
  assert.equal(await h.escalate({ source: "preflight", kind: "provider", text: "x" }), false);
  assert.ok(h.lines.some((line) => line.includes("delivery transport threw: fake transport down")));
  assert.ok(h.lines.some((line) => line.startsWith("ALERT_DELIVERY_FAILED")));
});

test("a fake Telegram 401 is a failed escalation, never SENT", async () => {
  const transportLines = [];
  const sender = createOpsTelegramSender({
    token: "invalid-token",
    chat: "owner",
    request: async () => { throw new Error("Telegram sendMessage HTTP 401"); },
    log: (line) => transportLines.push(line),
  });
  const h = memoryHarness(sender);
  assert.equal(await h.escalate({ source: "worker", kind: "crash-loop", text: "x" }), false);
  assert.ok(transportLines.some((line) => line.includes("Telegram sendMessage HTTP 401")));
  assert.ok(h.lines.some((line) => line.startsWith("ALERT_DELIVERY_FAILED")));
  assert.equal(h.lines.some((line) => line.includes("SENT to owner")), false);
});

test("only confirmed delivery returns true and enters cooldown", async () => {
  let attempts = 0;
  const h = memoryHarness(async () => { attempts += 1; return true; });
  const issue = { source: "worker", kind: "hung-job", text: "test alarm" };
  assert.equal(await h.escalate(issue), true);
  assert.equal(await h.escalate(issue), false);
  assert.equal(attempts, 1);
  assert.equal(h.state()["worker:hung-job"].lastSent, 1_000_000_000_000);
  assert.ok(h.lines.some((line) => line === "alert[worker:hung-job]: SENT to owner."));
});
