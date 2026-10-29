import { test } from "node:test";
import assert from "node:assert/strict";
import { alertKey, decide, clearKey, prune, COOLDOWN } from "./alert-core.mjs";

const HOUR = 3600_000;
const t0 = 1_000_000_000_000;

test("alertKey is stable per source+kind", () => {
  assert.equal(alertKey("better-life", "login"), "better-life:login");
});

test("first occurrence of a crucial alert sends", () => {
  const r = decide({}, "x:login", "crucial", t0);
  assert.equal(r.send, true);
  assert.equal(r.state["x:login"].lastSent, t0);
});

test("same alert within cooldown is suppressed", () => {
  let s = {};
  const a = decide(s, "x:login", "crucial", t0); s = a.state;
  const b = decide(s, "x:login", "crucial", t0 + 1 * HOUR);
  assert.equal(b.send, false);
  assert.equal(b.reason, "cooldown");
  assert.equal(b.state["x:login"].count, 2); // still tracked
});

test("alert sends again after the cooldown elapses", () => {
  let s = {};
  s = decide(s, "x:billing", "crucial", t0).state;
  const later = decide(s, "x:billing", "crucial", t0 + COOLDOWN.crucial + 1);
  assert.equal(later.send, true);
});

test("noise severity never sends", () => {
  const r = decide({}, "x:transient", "noise", t0);
  assert.equal(r.send, false);
  assert.equal(r.reason, "noise");
});

test("info cooldown is a full day", () => {
  let s = {};
  s = decide(s, "x:digest", "info", t0).state;
  assert.equal(decide(s, "x:digest", "info", t0 + 12 * HOUR).send, false);
  assert.equal(decide(s, "x:digest", "info", t0 + 25 * HOUR).send, true);
});

test("clearKey resets so the next occurrence sends immediately", () => {
  let s = decide({}, "x:login", "crucial", t0).state;
  s = clearKey(s, "x:login");
  assert.equal(s["x:login"], undefined);
  assert.equal(decide(s, "x:login", "crucial", t0 + 1 * HOUR).send, true); // not blocked by cooldown
});

test("prune drops stale entries", () => {
  const s = { old: { lastSent: t0 - 40 * 86_400_000 }, fresh: { lastSent: t0 } };
  const out = prune(s, t0);
  assert.equal(out.old, undefined);
  assert.ok(out.fresh);
});
