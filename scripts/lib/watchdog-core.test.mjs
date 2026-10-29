import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isApproved, hkTodayStr, weekdayDate, postDate, isOverdue, reconcile, classifyFailure, escalationMsg,
} from "./watchdog-core.mjs";

// 2026-06-19 is a Friday. 13:00 HK = 05:00 UTC.
const FRI_13_HK = Date.UTC(2026, 5, 19, 5, 0, 0);

test("isApproved gates on status", () => {
  assert.equal(isApproved({ status: "approved" }), true);
  assert.equal(isApproved({ status: "pending" }), false);
  assert.equal(isApproved({ status: "skip" }), false);
});

test("hkTodayStr is the HK calendar day", () => {
  assert.equal(hkTodayStr(FRI_13_HK), "2026-06-19");
  // 23:30 UTC on 06-18 is already 07:30 HK on 06-19
  assert.equal(hkTodayStr(Date.UTC(2026, 5, 18, 23, 30)), "2026-06-19");
});

test("weekdayDate maps a Better Life day to this week's date", () => {
  // week of Mon 2026-06-15 … Fri 2026-06-19
  assert.equal(weekdayDate({ day: "MON" }, FRI_13_HK), "2026-06-15");
  assert.equal(weekdayDate({ day: "WED" }, FRI_13_HK), "2026-06-17");
  assert.equal(weekdayDate({ day: "FRI" }, FRI_13_HK), "2026-06-19");
});

test("postDate prefers explicit date, else weekday", () => {
  assert.equal(postDate({ date: "2026-06-22" }, FRI_13_HK), "2026-06-22");
  assert.equal(postDate({ day: "MON" }, FRI_13_HK), "2026-06-15");
});

test("isOverdue is true only for days strictly before today", () => {
  assert.equal(isOverdue({ date: "2026-06-17" }, FRI_13_HK), true);   // Wed < Fri
  assert.equal(isOverdue({ date: "2026-06-19" }, FRI_13_HK), false);  // today
  assert.equal(isOverdue({ date: "2026-06-22" }, FRI_13_HK), false);  // future
  assert.equal(isOverdue({ day: "MON" }, FRI_13_HK), true);           // Mon < Fri
  assert.equal(isOverdue({ day: "FRI" }, FRI_13_HK), false);          // today
});

test("reconcile splits live vs missing by marker", () => {
  const approved = [{ slug: "a", __marker: "AAA" }, { slug: "b", __marker: "BBB" }, { slug: "c", __marker: "CCC" }];
  const live = new Set(["AAA", "CCC"]);
  const r = reconcile(approved, live);
  assert.deepEqual(r.live.map((x) => x.slug), ["a", "c"]);
  assert.deepEqual(r.missing.map((x) => x.slug), ["b"]);
});

test("classifyFailure buckets login / billing / transient / unknown", () => {
  assert.equal(classifyFailure("Error: NOT_LOGGED_IN"), "login");
  assert.equal(classifyFailure("Billing hard limit has been reached"), "billing");
  assert.equal(classifyFailure("insufficient_quota"), "billing");
  // the interrupted-run error that falsely alarmed the owner is now transient (not escalated)
  assert.equal(classifyFailure("page.goto: Target page, context or browser has been closed"), "transient");
  assert.equal(classifyFailure("Timeout 30000ms exceeded"), "transient");
  assert.equal(classifyFailure("net::ERR_CONNECTION_RESET"), "transient");
  assert.equal(classifyFailure("something genuinely weird happened"), "unknown");
});

test("escalationMsg returns brand-labelled guidance", () => {
  assert.match(escalationMsg("login", "脫敏德"), /脫敏德/);
  assert.match(escalationMsg("login", "脫敏德"), /登入/);
  assert.match(escalationMsg("billing", "百達利"), /額度/);
});
